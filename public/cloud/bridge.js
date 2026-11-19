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
import { RelayClient } from "./relay-client.js";
import { MAX_AUDIO_SIZE } from "./wire.js";

const EMPTY_UPDATE = { current: "云端版", latest: "", hasUpdate: false, autoUpdate: false, ready: false };
const toHex = (bytes) => [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");
const randomSecret = () => toHex(crypto.getRandomValues(new Uint8Array(16)));

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
    this.initialized = false;
  }

  async isGM() {
    return (await this.OBR.player.getRole()) === "GM";
  }

  async start() {
    if (this.initialized) return this;
    this.initialized = true;
    this.OBR.room.onMetadataChange((metadata) => {
      this.receiveState(normalizeState(metadata?.[METADATA_KEY]));
    });
    this.OBR.broadcast.onMessage(BROADCAST_CHANNEL, (event) => {
      const data = event.data;
      if (data?.t === "changed" && data.rev > (this.state?.rev || 0)) {
        this.refresh().catch(console.warn);
      }
      if (data?.t === "clock-ping") {
        // 只有 GM 设备响应，避免多个玩家时钟互相污染。
        this.isGM().then((gm) => {
          if (gm && data.id && Number.isFinite(data.t0)) {
            return this.OBR.broadcast.sendMessage(BROADCAST_CHANNEL, {
              t: "clock-pong", id: data.id, t0: data.t0, gmTime: Date.now(),
            });
          }
        }).catch(console.warn);
      }
      if (data?.t === "clock-pong" && this.clockRequests.has(data.id)) {
        const t2 = Date.now();
        const t0 = this.clockRequests.get(data.id);
        this.clockRequests.delete(data.id);
        const roundTrip = t2 - t0;
        if (roundTrip >= 0 && roundTrip < this.bestRoundTrip && roundTrip < 15000) {
          this.bestRoundTrip = roundTrip;
          this.skew = data.gmTime - (t0 + t2) / 2;
          this.emit();
        }
      }
    });
    await this.refresh();
    // 未创建音乐房间时，GM 初始化一次。其后非 GM 仅监听 OBR 元数据变化。
    if (!this.state && await this.isGM()) {
      const latest = normalizeState((await this.OBR.room.getMetadata())?.[METADATA_KEY]);
      if (latest) this.receiveState(latest);
      else await this.commit(createState(randomSecret()));
    }
    if (!await this.isGM()) this.calibrateClock().catch(console.warn);
    return this;
  }

  async calibrateClock() {
    // 单次握手，不设周期性“心跳”。连接到同一房间的 GM 不在线时使用上次估计。
    const id = crypto.randomUUID();
    const t0 = Date.now();
    this.clockRequests.set(id, t0);
    await this.OBR.broadcast.sendMessage(BROADCAST_CHANNEL, { t: "clock-ping", id, t0 });
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
    this.state = state;
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

  async refresh() {
    const data = await this.OBR.room.getMetadata();
    await this.receiveState(normalizeState(data?.[METADATA_KEY]));
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
    await this.OBR.room.setMetadata({ [METADATA_KEY]: next });
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
      if (!this.state) throw new Error("房间歌单尚未创建");
      const next = await transform(this.state);
      // 过期的 ended(expectedSeq) 应当是纯空操作，不要为同一修订
      // 重复写 Owlbear Metadata 和 Broadcast，尤其不能打断玩家进度。
      if (next.rev === this.state.rev) {
        return { state: this.getState(), now: this.getNow() };
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
      if (!this.state) await this.commit(createState(randomSecret()));
      return { token: "cloud-gm" };
    }
    if (/\/heartbeat$/.test(path)) return {};
    if (/\/release$/.test(path)) return {};
    if (/\/command$/.test(path)) return this.change((s) => applyCommand(s, body));
    if (/\/tracks\/bilibili$/.test(path)) {
      throw new Error("云版暂未支持原版需要 Node 抓取的 B 站歌曲；请先上传本地音频文件");
    }
    throw new Error(`云版不支持的操作接口：${path}`);
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
