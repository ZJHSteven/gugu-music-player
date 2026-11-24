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
  assertCloudStateSize, publicNow, publicState, applyCommand, addTrack,
} from "./state.js";
import { digest, getAudio, putAudio, requestPersistence } from "./storage.js";
import { createBackupArchive, readBackupArchive } from "./backup.js";
import { projectPlayback } from "./plan.js";
import {
  ROOM_METADATA_LIMIT, ROOM_SNAPSHOT_THRESHOLD,
  encodedSize, isSnapshotPointer, saveRoomSnapshot, loadRoomSnapshot,
} from "./room-snapshots.js";
import { inspectRoomMetadata, estimatePointerRoomBytes } from "./metadata-inspection.js";
import { RelayClient } from "./relay-client.js";
import { MAX_AUDIO_SIZE } from "./wire.js";
import { validatePlaylist, verifyCachedAudio } from "./source-health.js";

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
    this.healthListeners = new Set();
    this.audioHealth = {
      checking: false, localMissing: [], corrupt: [], fetching: [], unavailable: [],
      remoteMissing: [], metadataError: "", transferError: "",
    };
    this.lastMissingBroadcast = new Map();
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
    this.metadataReads = 0;
    this.metadataReadFailures = 0;
    this.metadataChangeEvents = 0;
    this.lastReadHadMusic = false;
    this.metadataInspection = null;
    this.writeAttempts = 0;
    this.writeFailures = 0;
    this.lastWriteStage = "none";
  }

  startupDiagnostics() {
    return {
      roomIdPresent: Boolean(this.roomId),
      metadataReads: this.metadataReads,
      metadataReadFailures: this.metadataReadFailures,
      metadataChangeEvents: this.metadataChangeEvents,
      lastReadHadMusic: this.lastReadHadMusic,
      sessionReady: Boolean(this.state),
      ...this.metadataInspection,
      writeAttempts: this.writeAttempts,
      writeFailures: this.writeFailures,
      lastWriteStage: this.lastWriteStage,
    };
  }

  async isGM() {
    return (await this.OBR.player.getRole()) === "GM";
  }

  async start() {
    if (this.initialized) return this;
    this.initialized = true;
    this.OBR.room.onMetadataChange((metadata) => {
      this.metadataChangeEvents++;
      this.metadataInspection = inspectRoomMetadata(metadata, METADATA_KEY);
      this.receiveMetadata(metadata)
        .then(() => { this.lastReadHadMusic = Boolean(this.state); })
        .catch((error) => {
          this.metadataReadFailures++;
          this.reportMetadataError(error);
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
      // 仅当歌单确有对应音频时才展示房间故障信息。广播只作提示，
      // 不允许远端成员借此更改 Metadata、权限或播放时间轴。
      if ((data?.t === "audio-unavailable" || data?.t === "audio-available") &&
          this.state?.playlist?.some((track) => track.hash === data.hash)) {
        const remote = new Set(this.audioHealth.remoteMissing);
        if (data.t === "audio-unavailable") remote.add(data.hash);
        else remote.delete(data.hash);
        this.updateHealth({ remoteMissing: [...remote] });
      }
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
    try { await this.refresh(); }
    catch (error) {
      this.reportMetadataError(error);
      // 一次性getMetadata失败不应阻止有限重试、也不应伪称空歌单。
      console.warn("[gugu-cloud] 初次读取房间状态失败，后续补偿重读", error);
    }
    // 某些复杂房间（梅林的房间尤其明显）在扩展首次载入时，Owlbear
    // SDK 虽然就绪，但第一次 getMetadata() 尚未含其他客户端已写入的状态。
    // 无状态不等于空房间：只在启动后的有限时间重读 3 次；如果 GM
    // 之后创建了状态，onMetadataChange 仍然会正常立即触发。
    // 无需刷新整个 Owlbear 页面，也不会对 DO 发周期请求。
    for (const delay of [2000, 5000, 12_000]) {
      const timer = setTimeout(() => {
        if (!this.state && !this.initializingState) {
          this.refresh().catch((error) => {
            console.warn("[gugu-cloud] 初始化期间重读房间音乐状态失败", error);
          });
        }
      }, delay);
      timer.unref?.();
    }
    // 房间初始化改为惰性：GM 首次上传、创建分类或领取控制权时进行。
    // 这样空房间的两个 iframe 不会争抢不同随机 secret，也不会在用户
    // 仅仅查看别人的房间时，无意消耗其公共 Metadata 配额。
    // 所有角色都需要校准，包括「同一 GM 账号在两台设备上」的情况。
    // 不发送周期 DO 心跳。播放时每 30 秒做一次低开销 Owlbear
    // Broadcast 时间探针，防止手机系统时钟长时间漂移导致“目标时间”
    // 本身渐渐偏离。这里校准的是时钟，音频偏差仍由 Engine 闭环纠正。
    this.calibrateClock().catch(console.warn);
    this.clockMaintenance = setInterval(() => {
      if (this.state?.playback?.playing &&
          Date.now() - this.lastCalibrationAt > 30_000) {
        this.calibrateClock().catch(console.warn);
      }
    }, 30_000);
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
    // 每轮周期校准重新比较 RTT，而不是永久保留第一次的最小值。
    // 否则设备连续工作数小时后，手机时钟漂移可能永远得不到更新。
    if (Date.now() - this.lastCalibrationAt > 60 * 1000) {
      this.bestRoundTrip = Infinity;
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

  onHealth(listener) {
    this.healthListeners.add(listener);
    listener({ ...this.audioHealth });
    return () => this.healthListeners.delete(listener);
  }

  updateHealth(patch) {
    const next = { ...this.audioHealth, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.audioHealth)) return;
    this.audioHealth = next;
    for (const listener of this.healthListeners) {
      try { listener({ ...this.audioHealth }); } catch (error) { console.warn(error); }
    }
  }

  reportMetadataError(error) {
    this.updateHealth({ metadataError: `房间歌单校验失败：${error?.message || "未知错误"}` });
  }

  // 本机缺失和全房间暂无在线音源是两种不同的状态。
  // 广播仅提醒房主排查，绝不删歌或阻断正常歌曲播放。
  onAudioAvailability(event) {
    if (event.type === "local-audit") {
      this.updateHealth({ checking: false, localMissing: event.missing,
        corrupt: event.invalid });
      return;
    }
    const hash = event.hash;
    if (!this.state?.playlist.some((t) => t.hash === hash)) return;
    if (event.type === "requesting") {
      this.updateHealth({
        fetching: [...new Set([...this.audioHealth.fetching, hash])],
        unavailable: this.audioHealth.unavailable.filter((x) => x !== hash),
      });
      return;
    }
    if (event.type === "unavailable" || event.type === "transfer-error") {
      this.updateHealth({
        fetching: this.audioHealth.fetching.filter((x) => x !== hash),
      });
      this.updateHealth({ unavailable: [...new Set([...this.audioHealth.unavailable, hash])] });
      if (event.type === "transfer-error") {
        this.updateHealth({ transferError: "音频多次传输失败，已提醒房主检查原文件或网络连接" });
      }
      const now = Date.now();
      if (now - (this.lastMissingBroadcast.get(hash) || 0) > 60_000) {
        this.lastMissingBroadcast.set(hash, now);
        this.OBR.broadcast.sendMessage(BROADCAST_CHANNEL,
          { t: "audio-unavailable", hash }).catch(console.warn);
      }
    } else if (event.type === "source-found" || event.type === "available") {
      const wasMissing = this.audioHealth.unavailable.includes(hash) ||
        this.audioHealth.remoteMissing.includes(hash);
      const remaining = this.audioHealth.unavailable.filter((x) => x !== hash);
      const change = { unavailable: remaining,
        remoteMissing: this.audioHealth.remoteMissing.filter((x) => x !== hash) };
      if (event.type === "available") {
        change.fetching = this.audioHealth.fetching.filter((x) => x !== hash);
      }
      if (event.type === "available") {
        change.localMissing = this.audioHealth.localMissing.filter((x) => x !== hash);
        change.corrupt = this.audioHealth.corrupt.filter((x) => x.hash !== hash);
        if (!remaining.length) change.transferError = "";
        this.OBR.broadcast.sendMessage(BROADCAST_CHANNEL,
          { t: "audio-available", hash }).catch(console.warn);
      } else if (wasMissing) {
        // 新上线的来源已经向 DO 登记，旧「缺失」告警应同步消失，
        // 而不能持续挂在 GM 面板上直到所有人重新打开房间。
        this.OBR.broadcast.sendMessage(BROADCAST_CHANNEL,
          { t: "audio-available", hash }).catch(console.warn);
      }
      this.updateHealth(change);
    }
  }

  emit() {
    if (!this.state) return;
    for (const callback of this.listeners) {
      try { callback(this.getState(), this.getNow()); } catch (e) { console.error(e); }
    }
  }

  async receiveState(state) {
    if (!state) return;
    try { validatePlaylist(state); }
    catch (error) { this.reportMetadataError(error); throw error; }
    const different = !this.state || this.state.secret !== state.secret;
    if (!different && this.state.rev > state.rev) return;
    const oldClockId = this.state?.playback?.clockId || "";
    this.state = state;
    const validHashes = new Set(state.playlist.map((t) => t.hash));
    this.updateHealth({
      metadataError: "", checking: true,
      localMissing: this.audioHealth.localMissing.filter((hash) => validHashes.has(hash)),
      fetching: this.audioHealth.fetching.filter((hash) => validHashes.has(hash)),
      unavailable: this.audioHealth.unavailable.filter((hash) => validHashes.has(hash)),
      remoteMissing: this.audioHealth.remoteMissing.filter((hash) => validHashes.has(hash)),
    });
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
        (error) => {
          console.warn("[gugu-cloud] 文件中继错误", error);
          this.updateHealth({ transferError: "音频传输失败，请检查连接或由房主补传原文件" });
        },
        (event) => this.onAudioAvailability(event)
      );
      this.relay.connect();
    }
    // 很晚才进入房间的玩家可能已经错过数轮自然切歌。
    // 必须优先请求“此刻预测的歌曲”，而不是历史播放指令里最初的 trackId。
    const activeTrack = this.getNow()?.playback?.trackId || state.playback?.trackId;
    this.relay?.updateTracks(state.playlist, activeTrack).catch((error) => {
      this.updateHealth({ checking: false,
        transferError: `本地音频校验失败：${error.message}` });
    });
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
    if (value !== undefined && value !== null && !state) {
      throw new Error("房间音乐元数据格式或版本不正确，请恢复完整歌单备份");
    }
    if (state) this.snapshotPointer = null;
    await this.receiveState(state);
  }

  async refresh() {
    this.metadataReads++;
    try {
      const data = await this.OBR.room.getMetadata();
      this.metadataInspection = inspectRoomMetadata(data, METADATA_KEY);
      await this.receiveMetadata(data);
      this.lastReadHadMusic = Boolean(this.state);
    } catch (error) {
      this.metadataReadFailures++;
      this.reportMetadataError(error);
      throw error;
    }
  }

  getState() {
    return this.state ? publicState(this.state) : null;
  }

  getNow() {
    if (!this.state) return null;
    // 所有设备都用音频源的绝对时钟推导当前曲目；然后把锚点换回
    // 本设备时间，供 HTMLAudioElement 的本地纠偏函数直接使用。
    const now = publicNow(this.state, Date.now() + this.skew);
    // 把 GM 机器的绝对 anchor 转成本机时间轴。
    now.playback.anchor -= this.skew;
    return now;
  }

  async commit(next) {
    if (!await this.isGM()) throw new Error("只有 Owlbear 房主能修改歌单和播放状态");
    this.writeAttempts++;
    let stage = "preflight";
    try {
      assertCloudStateSize(next);
      const metadata = await this.OBR.room.getMetadata();
      this.metadataInspection = inspectRoomMetadata(metadata, METADATA_KEY);
      const totalBytes = encodedSize({ ...metadata, [METADATA_KEY]: next });
      // 一旦迁移到 v2 就保持指针格式，不因其他插件变动而来回振荡。
      const usePointer = Boolean(this.snapshotPointer) ||
        totalBytes > ROOM_SNAPSHOT_THRESHOLD;
      if (usePointer) {
        // 先计算指针的真实占用，确认至少能塞进 Owlbear 共享16KiB。
        // 旧顺序先写DO后发现指针放不下，会制造无人引用的孤儿快照。
        stage = "pointer-capacity";
        const pointerBytes = estimatePointerRoomBytes(metadata, METADATA_KEY, next.rev);
        if (pointerBytes > ROOM_METADATA_LIMIT) {
          throw new Error(
            `房间已占用 ${encodedSize(metadata)} 字节，加入咕咕DO快照指针需 ${pointerBytes} 字节，但Owlbear总上限 ${ROOM_METADATA_LIMIT} 字节。请房主清理其他扩展的过量Metadata；仅扩大DO无法解决。`
          );
        }
        stage = "snapshot-save";
        const pointer = await saveRoomSnapshot(this.roomId, next.secret, next);
        stage = "room-write";
        await this.OBR.room.setMetadata({ [METADATA_KEY]: pointer });
        this.snapshotPointer = pointer;
        this.metadataInspection = inspectRoomMetadata(
          { ...metadata, [METADATA_KEY]: pointer }, METADATA_KEY);
      } else {
        stage = "room-write";
        await this.OBR.room.setMetadata({ [METADATA_KEY]: next });
        this.metadataInspection = inspectRoomMetadata(
          { ...metadata, [METADATA_KEY]: next }, METADATA_KEY);
      }
      stage = "state-apply";
      await this.receiveState(next);
      this.lastWriteStage = "success";
      // Metadata 自带持久同步，Broadcast 只用于催促其他玩家立即更新。
      this.OBR.broadcast.sendMessage(BROADCAST_CHANNEL, { t: "changed", rev: next.rev }).catch(console.warn);
      return { state: this.getState(), now: this.getNow() };
    } catch (error) {
      this.writeFailures++;
      this.lastWriteStage = stage;
      throw error;
    }
  }

  /**
   * 串行化同个页面中的操作，避免连续按钮把早期状态覆盖到最新元数据上。
   * 不同设备同时操作的冲突由 GM 权限约束；同一 GM 多端并发仍应避免。
   */
  change(transform, { metadataOnly = false } = {}) {
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
      const sourceNow = Date.now() + offset;
      // GM 在第 N 首播放中按“暂停/下一首/改音量/加歌”时，
      // 首先把旧时间轴推导为实际正在播放的歌曲再执行修改。
      // 否则历史锚点仍停在一开始那首歌，用户一操作就会跳回过去。
      const source = { ...this.state,
        playback: projectPlayback(this.state, sourceNow) };
      const next = await transform(source, sourceNow);
      // 过期的 ended(expectedSeq) 应当是纯空操作，不要为同一修订
      // 重复写 Owlbear Metadata 和 Broadcast，尤其不能打断玩家进度。
      if (next.rev === this.state.rev) {
        return { state: this.getState(), now: this.getNow() };
      }
      // 已完成状态变更后，把锚点从旧设备时钟转换到「本设备」时钟，
      // 同时更新唯一时钟源。其他客户端收到 metadata 后只向该设备校准。
      if (metadataOnly) {
        // 重命名只更新歌单描述，沿用原来的播放源/时间锚点。
        // 不允许更改歌名造成所有设备重新校时或跳曲。
        next.playback = { ...this.state.playback };
      } else {
        next.playback.anchor -= offset;
        next.playback.clockId = this.deviceId;
      }
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
    if (/\/command$/.test(path)) return this.change(
      (s, now) => applyCommand(s, body, now),
      { metadataOnly: body?.type === "track.update" ||
        (body?.type === "playlist" && body?.op === "move") ||
        body?.type === "folder" || body?.type === "track.folder" }
    );
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

  async uploadTrack({ file, duration, folder, onProgress, meta = {} }) {
    if (!await this.isGM()) throw new Error("只有 Owlbear 房主可以添加歌曲");
    if (!file?.size || file.size > MAX_AUDIO_SIZE) throw new Error("单个音频文件必须在 0～64 MiB 之间");
    const hash = await digest(file);
    onProgress?.(0.1);
    await putAudio(hash, file);
    await requestPersistence();
    onProgress?.(0.6);
    const result = await this.change((s) => addTrack(s, {
      ...meta,
      hash, title: meta.title || file.name.replace(/\.[^.]+$/, ""), size: file.size,
      mime: file.type || "audio/mpeg", duration: Number(meta.duration) > 0 ? Number(meta.duration) : duration, folder,
    }));
    await this.relay?.announce(hash);
    onProgress?.(1);
    return result;
  }

  /**
   * 原文件补传分两步：
   * - 哈希一致：直接补齐，不修改 Metadata。
   * - 哈希不同：只返回风险信息，要求用户再次确认后才替换版本。
   * 绝不能把新文件写到旧 SHA-256 对应的 OPFS 键中。
   */
  async inspectRepairTrack(trackId, file) {
    if (!await this.isGM()) throw new Error("只有房主能补传歌曲原文件");
    await this.refresh();
    const track = this.state?.playlist.find((item) => item.id === trackId);
    if (!track) throw new Error("待补传的歌曲已不在房间歌单");
    if (!file?.size || file.size > MAX_AUDIO_SIZE) {
      throw new Error("音频文件应大于 0 且不能超过 64 MiB");
    }
    const newHash = await digest(file);
    return {
      trackId, title: track.title, oldHash: track.hash, newHash,
      oldSize: track.size, newSize: file.size,
      needsConfirmation: newHash !== track.hash || file.size !== track.size,
    };
  }

  async repairTrack(trackId, file, {
    confirmVersionChange = false, expectedOldHash = "", approvedNewHash = "",
    duration = 0,
  } = {}) {
    const preview = await this.inspectRepairTrack(trackId, file);
    if (preview.needsConfirmation && !confirmVersionChange) {
      return preview; // 只提示，不拒绝，也不写入音频或 Metadata
    }
    if (preview.needsConfirmation &&
        (preview.oldHash !== expectedOldHash || preview.newHash !== approvedNewHash)) {
      throw new Error("歌单中的音频版本或待上传文件已发生变化，请重新选择并确认");
    }
    const savedTo = await putAudio(preview.newHash, file);
    await requestPersistence();
    if (preview.needsConfirmation) {
      await this.change((state) => {
        const track = state.playlist.find((item) => item.id === trackId);
        if (!track || track.hash !== preview.oldHash) {
          throw new Error("歌曲已被其他操作修改，不能覆盖，请重新选择文件");
        }
        track.hash = preview.newHash;
        track.size = preview.newSize;
        if (file.type?.startsWith("audio/")) track.mime = file.type;
        if (Number.isFinite(duration) && duration > 0) track.duration = duration;
        state.rev++;
        return state;
      }, { metadataOnly: true });
    }
    await this.relay?.announce(preview.newHash);
    return { ...preview, savedTo, changedVersion: preview.needsConfirmation };
  }

  /** GM 手动保存真正可离线恢复的 ZIP，不依赖浏览器缓存或 Cloudflare 存歌。 */
  async exportBackup() {
    if (!await this.isGM()) throw new Error("只有 Owlbear 房主可以导出歌单备份");
    await this.refresh();
    const available = new Map();
    const missing = [];
    for (const track of this.state.playlist) {
      if (available.has(track.hash)) continue;
      const result = await verifyCachedAudio(track, getAudio, digest);
      if (!result.valid) {
        missing.push(track.title);
        continue;
      }
      available.set(track.hash, await getAudio(track.hash));
    }
    if (missing.length) throw new Error(`有 ${missing.length} 首歌曲缺少完整原文件：${missing.slice(0, 5).join("、")}。请补传或等待其他成员同步后再生成完整 ZIP`);
    return createBackupArchive(this.state.playlist, available);
  }

  /** 从用户主动选择的本地 ZIP 恢复音频与缺失的歌单项，不覆盖其他歌曲。 */
  async importBackup(file) {
    if (!await this.isGM()) throw new Error("只有 Owlbear 房主可以恢复歌单备份");
    // ZIP 中少数原文件缺失时，只恢复其余完整音频；版本不兼容、
    // ZIP 结构/CRC 损坏仍会在任何 OPFS 写入前直接拒绝。
    const archive = await readBackupArchive(file, { allowPartial: true });
    await this.refresh();
    if (!this.state) await this.ensureRoomState();
    const existing = this.state.playlist;
    const mismatched = archive.tracks.filter((track) =>
      !existing.some((item) => item.hash === track.hash) &&
      existing.some((item) => item.title === track.title && item.hash !== track.hash)
    );
    const missingFromZip = archive.missing || [];
    const incomplete = new Set(missingFromZip.map((t) => t.hash));
    const accepted = archive.tracks.filter((track) =>
      !mismatched.includes(track) && !incomplete.has(track.hash));
    const unique = [...new Set(accepted.map((t) => t.hash))];
    // 先完整核验再写入本地存储；恶意 ZIP 不能向 OPFS 写入任意文件名。
    for (const hash of unique) {
      if ((await digest(archive.files.get(`audio/${hash}`))) !== hash) {
        throw new Error(`备份音频 SHA-256 不一致：${hash.slice(0, 12)}`);
      }
    }
    let restored = 0;
    let alreadyPresent = 0;
    let memoryOnly = 0;
    const failed = [];
    const failedHashes = new Set();
    for (const hash of unique) {
      const track = accepted.find((t) => t.hash === hash);
      try {
        const present = await verifyCachedAudio(track, getAudio, digest);
        if (present.valid) { alreadyPresent++; continue; }
        const savedTo = await putAudio(hash, archive.files.get(`audio/${hash}`));
        if (savedTo === "memory") memoryOnly++;
        restored++;
        await this.relay?.announce(hash);
      } catch (error) {
        failedHashes.add(hash);
        failed.push({ title: track.title, reason: String(error.message || error).slice(0, 120) });
      }
    }
    await requestPersistence();
    let added = 0;
    await this.change((state) => {
      let next = state;
      for (const track of accepted.filter((t) => !failedHashes.has(t.hash))) {
        // 用户可能曾经手动更名，只要音频哈希一致就属于同一曲，
        // 不能因 ZIP 里的旧标题不同而重复添加歌曲。
        if (next.playlist.some((item) => item.hash === track.hash)) continue;
        if (next.playlist.some((item) => item.title === track.title)) continue;
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
      assertCloudStateSize(next);
      return next;
    });
    const stillMissing = [];
    for (const track of this.state.playlist) {
      if (!(await verifyCachedAudio(track, getAudio, digest)).valid) {
        stillMissing.push(track.title);
      }
    }
    return { restored, alreadyPresent, added, memoryOnly,
      mismatched: mismatched.map((t) => t.title),
      missingFromZip: missingFromZip.map((t) => t.title),
      failed, stillMissing };
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
