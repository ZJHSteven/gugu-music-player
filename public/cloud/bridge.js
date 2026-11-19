/**
 * Owlbear Rodeo 房间同步适配器。
 *
 * 与原版 Node API 的差异：
 * - 房间状态直接来自 OBR.room.getMetadata/onMetadataChange，修改仅 GM 有权操作。
 * - OBR.broadcast 负责变更通知，音频播放的时间锚点完全由浏览器本地推算。
 * - DO 只处理缺失的二进制文件，绝不承担播放、暂停或逐秒进度同步。
 * - 继续使用旧版控制台和音频引擎，保留原 UI 的行为与指令格式。
 *
 * 一个浏览器的 background iframe 和 popover iframe 分别有 JS 运行环境：
 * 它们可各有一个中继连接，但只共享同源 OPFS/IDB。为避免重复传输，收到文件时
 * 先计算摘要并查本地；如果文件已存在则忽略重复传输。后续可进一步合并通道。
 */
import {
  METADATA_KEY, BROADCAST_CHANNEL, createState, normalizeState,
  assertMetadataSize, publicNow, publicState, applyCommand, addTrack,
} from "./state.js";
import { digest, getAudio, putAudio, requestPersistence } from "./storage.js";
import { createBackupArchive, readBackupArchive } from "./backup.js";
import {
  ROOM_METADATA_LIMIT, ROOM_SNAPSHOT_THRESHOLD,
  encodedSize, isSnapshotPointer, saveRoomSnapshot, loadRoomSnapshot,
} from "./room-snapshots.js";
import { RelayClient } from "./relay-client.js";
import { MAX_AUDIO_SIZE } from "./wire.js";

const EMPTY_UPDATE = { current: "云端版", latest: "", hasUpdate: false, autoUpdate: false, ready: false };
const toHex = (bytes) => [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");
const randomSecret = () => toHex(crypto.getRandomValues(new Uint8Array(16)));
// 同一浏览器里的弹窗和背景音频 iframe 共用一个设备时钟标识。
// 不使用 Owlbear player.id 代替：同一 GM 账号可在电脑与手机同时登录，
// 这时 player.id 相同，但两个设备的系统时钟、音频硬件明显不相同。
function localClockId(roomId) {
  const key = `gugu-cloud:clock-device:${roomId}`;
  try {
    let id = localStorage.getItem(key);
    if (!/^[0-9a-f-]{36}$/.test(id || "")) {
      id = crypto.randomUUID();
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

export class CloudBridge {
  constructor(OBR, roomId) {
    this.OBR = OBR;
    this.roomId = roomId;
    this.state = null;
    this.relay = null;
    this.listeners = new Set();
    this.fileListeners = new Set();
    this.writeChain = Promise.resolve();
    // GM 与玩家设备本地系统时钟可能不同，不能直接拿绝对 Date.now() 作跨端播放位置。
    // 通过 Owlbear Broadcast 单次 NTP 类时钟往返校准，完全不经过 Cloudflare DO。
    this.skew = 0;
    this.bestRoundTrip = Infinity;
    this.clockRequests = new Map();
    this.deviceId = localClockId(roomId);
    this.clockSource = "";
    this.lastCalibrationAt = 0;
    this.initialized = false;
    this.snapshotPointer = null;
    this.initializingState = null;
  }

  async isGM() {
    return (await this.OBR.player.getRole()) === "GM";
  }

  async start() {
    if (this.initialized) return this;
    this.initialized = true;
    this.OBR.room.onMetadataChange((metadata) => {
      this.receiveMetadata(metadata).catch((error) => {
        console.warn("[gugu-cloud] 读取房间歌单失败", error);
      });
    });
    // Owlbear 可以在页面已经启动以后把 PLAYER 提升成 GM。
    // 旧实现只在 start() 时查一次角色，导致提升权限后上传和建分类均显示
    //「房间歌单未创建」。监听角色事件，但只在 GM 首次执行写操作时初始化，
    // 避免同一设备的 popover/background 两个 iframe 同时竞态初始化。
    this.OBR.player.onChange?.((player) => {
      if (player.role === "GM" && !this.state) this.emit();
    });
    this.OBR.broadcast.onMessage(BROADCAST_CHANNEL, (event) => {
      const data = event.data;
      if (data?.t === "changed" && data.rev > (this.state?.rev || 0)) {
        this.refresh().catch(console.warn);
      }
      if (data?.t === "clock-ping") {
        // 只允许与当前播放元数据 clockId 精确对应的设备响应。
        // 这样电脑与手机同是 GM 时，也不会出现多个 pong 争夺校准结果。
        if (data.targetClockId === this.deviceId && data.id &&
            Number.isFinite(data.t0)) {
          this.OBR.broadcast.sendMessage(BROADCAST_CHANNEL, {
            t: "clock-pong", id: data.id, targetClockId: this.deviceId,
            t0: data.t0, gmTime: Date.now(),
          }).catch(console.warn);
        }
      }
      if (data?.t === "clock-pong" && this.clockRequests.has(data.id)) {
        const t2 = Date.now();
        const { t0, clockId } = this.clockRequests.get(data.id);
        this.clockRequests.delete(data.id);
        if (clockId !== this.state?.playback?.clockId ||
            data.targetClockId !== clockId) return;
        const roundTrip = t2 - t0;
        if (roundTrip >= 0 && roundTrip < this.bestRoundTrip && roundTrip < 15000) {
          this.bestRoundTrip = roundTrip;
          this.skew = data.gmTime - (t0 + t2) / 2;
          this.lastCalibrationAt = t2;
          this.emit();
        }
      }
    });
    await this.refresh();
    // 房间初始化改为惰性：GM 首次上传、创建分类或领取控制权时进行。
    // 这样空房间的两个 iframe 不会争抢不同随机 secret，也不会在用户
    // 仅仅查看别人的房间时，无意消耗其公共 Metadata 配额。
    // 所有角色都需要校准，包括「同一 GM 账号在两台设备上」的情况。
    // 不发送周期 DO 心跳；播放期间每 5 分钟向当前时钟源校准一次即可。
    this.calibrateClock().catch(console.warn);
    this.clockMaintenance = setInterval(() => {
      if (this.state?.playback?.playing &&
          Date.now() - this.lastCalibrationAt > 5 * 60 * 1000) {
        this.calibrateClock().catch(console.warn);
      }
    }, 5 * 60 * 1000);
    this.clockMaintenance.unref?.();
    return this;
  }

  async calibrateClock() {
    const targetClockId = this.state?.playback?.clockId;
    if (!targetClockId || targetClockId === this.deviceId) {
      this.skew = 0;
      this.lastCalibrationAt = Date.now();
      return;
    }
    // 广播两次轻量 NTP 风格时间探针，取 RTT 较低的一次，避免单次延迟
    // 把 Safari 手机的目标时间计算错几个秒。只比较指定 clockId 响应。
    const id = crypto.randomUUID();
    const t0 = Date.now();
    this.clockRequests.set(id, { t0, clockId: targetClockId });
    await this.OBR.broadcast.sendMessage(BROADCAST_CHANNEL,
      { t: "clock-ping", id, t0, targetClockId });
    const cleanup = setTimeout(() => this.clockRequests.delete(id), 15000);
    // Node 单元测试也复用 Bridge；一次性校准的清理任务不应阻止进程退出。
    cleanup.unref?.();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    if (this.state) listener(this.getState(), this.getNow());
    return () => this.listeners.delete(listener);
  }

  onFile(listener) {
    this.fileListeners.add(listener);
    return () => this.fileListeners.delete(listener);
  }

  emit() {
    if (!this.state) return;
    for (const callback of this.listeners) {
      try { callback(this.getState(), this.getNow()); } catch (e) { console.error(e); }
    }
  }

  async receiveState(state) {
    if (!state) return;
    const different = !this.state || this.state.secret !== state.secret;
    if (!different && this.state.rev > state.rev) return;
    const oldClockId = this.state?.playback?.clockId || "";
    this.state = state;
    const clockId = state.playback?.clockId || "";
    if (clockId !== oldClockId && clockId !== this.deviceId) {
      // 时钟源改变：舍弃旧源的偏移，主动对新源发起指定设备校准。
      this.skew = 0;
      this.bestRoundTrip = Infinity;
      this.calibrateClock().catch(console.warn);
      setTimeout(() => this.calibrateClock().catch(console.warn), 300);
    } else if (clockId === this.deviceId) {
      this.skew = 0;
      this.lastCalibrationAt = Date.now();
    }
    if (different) {
      this.relay?.close();
      this.relay = new RelayClient(
        this.roomId, state.secret,
        (hash) => this.fileListeners.forEach((listener) => listener(hash)),
        (error) => console.warn("[gugu-cloud] 文件中继错误", error)
      );
      this.relay.connect();
    }
    this.relay?.updateTracks(state.playlist, state.playback?.trackId).catch(console.warn);
    this.emit();
  }

  /**
   * 支持两种正交的 Owlbear 元数据格式：
   * v1 = 直接放完整歌单（旧房间无需迁移）；
   * v2 = 仅存本房间的不可变快照 SHA256 指针（复杂房间）。
   *
   * 下载快照可能因网络异步完成。后到的旧版 rev 不能覆盖较新 rev。
   */
  async receiveMetadata(metadata) {
    const value = metadata?.[METADATA_KEY];
    if (isSnapshotPointer(value)) {
      if (this.state?.rev > value.rev) return;
      if (this.snapshotPointer?.hash === value.hash &&
          this.state?.rev === value.rev) return;
      const state = normalizeState(await loadRoomSnapshot(this.roomId, value));
      if (!state || state.rev !== value.rev || state.secret !== value.secret) {
        throw new Error("房间歌单快照格式不正确或摘要不匹配");
      }
      if (this.state?.rev > state.rev) return;
      this.snapshotPointer = value;
      await this.receiveState(state);
      return;
    }
    const state = normalizeState(value);
    if (state) this.snapshotPointer = null;
    await this.receiveState(state);
  }

  async refresh() {
    const data = await this.OBR.room.getMetadata();
    await this.receiveMetadata(data);
  }

  getState() {
    return this.state ? publicState(this.state) : null;
  }

  getNow() {
    if (!this.state) return null;
    const now = publicNow(this.state);
    // 把 GM 机器的绝对 anchor 转成本机时间轴。
    now.playback.anchor -= this.skew;
    return now;
  }

  async commit(next) {
    if (!await this.isGM()) throw new Error("只有 Owlbear 房主能修改歌单和播放状态");
    assertMetadataSize(next);
    const metadata = await this.OBR.room.getMetadata();
    const totalBytes = encodedSize({ ...metadata, [METADATA_KEY]: next });
    // 一旦迁移到 v2 就保持指针格式，不要因其他插件减少数据量来回振荡。
    const usePointer = Boolean(this.snapshotPointer) ||
      totalBytes > ROOM_SNAPSHOT_THRESHOLD;
    if (usePointer) {
      const pointer = await saveRoomSnapshot(this.roomId, next.secret, next);
      // DO 快照先写好，之后才能通过 Owlbear GM 授权更新其指针。
      // 绝不删除或覆盖其他扩展的任意 Metadata 键。
      const pointerBytes = encodedSize({ ...metadata, [METADATA_KEY]: pointer });
      if (pointerBytes > ROOM_METADATA_LIMIT) {
        throw new Error(
          `房间扩展共享元数据已占用 ${encodedSize(metadata)} 字节，剩余空间连咕咕的最小歌单指针也放不下。请房主清理其他扩展的多余数据。`
        );
      }
      await this.OBR.room.setMetadata({ [METADATA_KEY]: pointer });
      this.snapshotPointer = pointer;
    } else {
      await this.OBR.room.setMetadata({ [METADATA_KEY]: next });
    }
    await this.receiveState(next);
    // Metadata 自带持久同步，Broadcast 只用于催促其他玩家立即更新。
    this.OBR.broadcast.sendMessage(BROADCAST_CHANNEL, { t: "changed", rev: next.rev }).catch(console.warn);
    return { state: this.getState(), now: this.getNow() };
  }

  /**
   * 串行化同个页面中的操作，避免连续按钮把早期状态覆盖到最新元数据上。
   * 不同设备同时操作的冲突由 GM 权限约束；同一 GM 多端并发仍应避免。
   */
  change(transform) {
    const result = this.writeChain.then(async () => {
      if (!await this.isGM()) throw new Error("需要 Owlbear 房主权限");
      await this.refresh();
      // 在刚获 GM 权限的房间，第一次写入同时完成空歌单初始化。
      // 不让任何「播放/上传/建分类」先于 v2 初始化，从而消灭只在初次
      // 载入页面时才判断角色的历史竞态。
      if (!this.state) await this.ensureRoomState();
      // 修改指令中的 Date.now() 必须先换算成当前播放源的时钟，否则同一个
      // GM 账号在手机上暂停/播放时，会把手机的绝对时间写到电脑锚点里。
      const offset = this.skew;
      const next = await transform(this.state, Date.now() + offset);
      // 过期的 ended(expectedSeq) 应当是纯空操作，不要为同一修订
      // 重复写 Owlbear Metadata 和 Broadcast，尤其不能打断玩家进度。
      if (next.rev === this.state.rev) {
        return { state: this.getState(), now: this.getNow() };
      }
      // 已完成状态变更后，把锚点从旧设备时钟转换到「本设备」时钟，
      // 同时更新唯一时钟源。其他客户端收到 metadata 后只向该设备校准。
      next.playback.anchor -= offset;
      next.playback.clockId = this.deviceId;
      return this.commit(next);
    });
    this.writeChain = result.catch(() => {});
    return result;
  }

  async apiGet(path) {
    if (path === "/api/update") return EMPTY_UPDATE;
    if (path === "/api/health") return { ok: true, time: Date.now() };
    if (/\/now$/.test(path)) return this.getNow();
    if (/\/state$/.test(path)) {
      if (!await this.isGM()) throw new Error("只有房主可查看完整歌单");
      return this.getState();
    }
    throw new Error(`云版不支持的读取接口：${path}`);
  }

  async apiPost(path, body) {
    if (/\/claim$/.test(path)) {
      if (!await this.isGM()) throw new Error("只有 Owlbear 房主可以获得控制权");
      if (!this.state) await this.ensureRoomState();
      return { token: "cloud-gm" };
    }
    if (/\/heartbeat$/.test(path)) return {};
    if (/\/release$/.test(path)) return {};
    if (/\/command$/.test(path)) return this.change((s, now) => applyCommand(s, body, now));
    if (/\/tracks\/bilibili$/.test(path)) {
      throw new Error("云版暂未支持原版需要 Node 抓取的 B 站歌曲；请先上传本地音频文件");
    }
    throw new Error(`云版不支持的操作接口：${path}`);
  }

  async ensureRoomState() {
    if (this.state) return;
    if (!await this.isGM()) throw new Error("需要 Owlbear 房主权限");
    if (!this.initializingState) {
      this.initializingState = (async () => {
        await this.refresh();
        if (!this.state) await this.commit(createState(randomSecret()));
      })().finally(() => { this.initializingState = null; });
    }
    return this.initializingState;
  }

  async uploadTrack({ file, duration, folder, onProgress }) {
    if (!await this.isGM()) throw new Error("只有 Owlbear 房主可以添加歌曲");
    if (!file?.size || file.size > MAX_AUDIO_SIZE) throw new Error("单个音频文件必须在 0～64 MiB 之间");
    const hash = await digest(file);
    onProgress?.(0.1);
    await putAudio(hash, file);
    await requestPersistence();
    onProgress?.(0.6);
    const result = await this.change((s) => addTrack(s, {
      hash, title: file.name.replace(/\.[^.]+$/, ""), size: file.size,
      mime: file.type || "audio/mpeg", duration, folder,
    }));
    await this.relay?.announce(hash);
    onProgress?.(1);
    return result;
  }

  /** GM 手动保存真正可离线恢复的 ZIP，不依赖浏览器缓存或 Cloudflare 存歌。 */
  async exportBackup() {
    if (!await this.isGM()) throw new Error("只有 Owlbear 房主可以导出歌单备份");
    await this.refresh();
    const available = new Map();
    for (const track of this.state.playlist) {
      if (available.has(track.hash)) continue;
      const audio = await getAudio(track.hash);
      if (!audio) throw new Error(`本机缺少《${track.title}》，请等缓存下载完整再备份`);
      if ((await digest(audio)) !== track.hash) {
        throw new Error(`《${track.title}》的本地缓存校验失败`);
      }
      available.set(track.hash, audio);
    }
    return createBackupArchive(this.state.playlist, available);
  }

  /** 从用户主动选择的本地 ZIP 恢复音频与缺失的歌单项，不覆盖其他歌曲。 */
  async importBackup(file) {
    if (!await this.isGM()) throw new Error("只有 Owlbear 房主可以恢复歌单备份");
    const archive = await readBackupArchive(file);
    const unique = [...new Set(archive.tracks.map((t) => t.hash))];
    // 先完整核验再写入本地存储；恶意 ZIP 不能向 OPFS 写入任意文件名。
    for (const hash of unique) {
      if ((await digest(archive.files.get(`audio/${hash}`))) !== hash) {
        throw new Error(`备份音频 SHA-256 不一致：${hash.slice(0, 12)}`);
      }
    }
    for (const hash of unique) {
      await putAudio(hash, archive.files.get(`audio/${hash}`));
      await this.relay?.announce(hash);
    }
    await requestPersistence();
    let added = 0;
    await this.change((state) => {
      let next = state;
      for (const track of archive.tracks) {
        if (next.playlist.some((item) =>
          item.hash === track.hash && item.title === track.title)) continue;
        const folder = String(track.folder || "").slice(0, 24);
        if (folder && !next.folders.includes(folder)) {
          next = { ...next, folders: [...next.folders, folder], rev: next.rev + 1 };
        }
        next = addTrack(next, {
          title: track.title, hash: track.hash, size: track.size,
          mime: track.mime, duration: track.duration, folder,
        });
        added++;
      }
      assertMetadataSize(next);
      return next;
    });
    return { restored: unique.length, added };
  }
}

let singleton = null;
export async function initCloudBridge(OBR, role, roomId) {
  if (singleton?.roomId === roomId) return singleton;
  // 每个 iframe 的 JS 运行环境都拥有独立 singleton，避免弹窗重复创建连接。
  const bridge = new CloudBridge(OBR, roomId);
  singleton = bridge;
  window.__cloudBridge = bridge;
  await bridge.start();
  return bridge;
}
