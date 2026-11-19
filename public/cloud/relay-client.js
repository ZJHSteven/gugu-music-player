/**
 * 在 GM、玩家任意浏览器之间同步缺失的歌曲文件。
 *
 * 不做直连 WebRTC；每个字节都从发送者浏览器经过一个 Cloudflare DO，
 * 再到接收者浏览器。与播放同步完全独立。平时 DO WebSocket 无应用心跳。
 *
 * 失败时按整个文件重试，而不是保留不完整文件；收到的音频必须先校验
 * SHA-256 才能进入 OPFS/IndexedDB。最大 64 MiB，单块 256 KiB。
 */
import { CHUNK_SIZE, MAX_AUDIO_SIZE, HASH_RE, decodeChunk, encodeChunk } from "./wire.js";
import { getAudio, putAudio, digest } from "./storage.js";
import { sendAudioWithoutAck } from "./audio-sender.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 每八个 256 KiB 分块才要求一次确认：窗口约 2 MiB。
// 背压比逐块确认省掉 7/8 的小控制包，并避免慢玩家缓存过多待处理帧。
const ACK_WINDOW = 8;

export class RelayClient {
  constructor(roomId, secret, onFile = () => {}, onError = () => {}) {
    this.roomId = roomId;
    this.secret = secret;
    this.onFile = onFile;
    this.onError = onError;
    this.tracks = [];
    this.ws = null;
    this.owned = new Set();
    this.requested = new Set();
    this.incoming = new Map();
    this.transferTimeouts = new Map();
    this.peer = null;
    this.lastAck = new Map();
    this.ackWaiters = new Map();
    this.serving = new Set();
    this.stopped = false;
    this.reconnectDelay = 500;
    // 同一个 Owlbear 房间会在同源的弹窗和后台 iframe 中各开一条 DO 连接。
    // 两者共享 OPFS/IndexedDB 文件，但不共享 JavaScript 内存状态。
    // 只广播已存入本地的音频 SHA-256，避免另一个 iframe 再次请求公网音频。
    this.localBus = null;
    try {
      this.localBus = new BroadcastChannel(`gugu-cloud:audio:${roomId}`);
      this.localBus.onmessage = (event) => {
        if (event.data?.t !== "saved") return;
        this.localFileSaved(event.data.hash).catch(this.onError);
      };
    } catch {
      // 隐私限制等环境可能不提供 BroadcastChannel，仍可继续以原流程下载。
    }
  }

  url() {
    const wsScheme = location.protocol === "https:" ? "wss:" : "ws:";
    return `${wsScheme}//${location.host}/relay?room=${encodeURIComponent(this.roomId)}&key=${this.secret}`;
  }

  send(data) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(data));
  }

  async updateTracks(tracks) {
    this.tracks = (tracks || []).filter((t) => HASH_RE.test(t.hash));
    const owned = new Set();
    for (const t of this.tracks) {
      if (await getAudio(t.hash)) owned.add(t.hash);
    }
    this.owned = owned;
    // 曲目状态更新时若文件早已由兄弟 iframe 保存，则清除仍在等待的
    // 请求和 30 秒重试定时器，避免本地已有文件仍反复唤醒 DO。
    for (const hash of owned) {
      this.requested.delete(hash);
      this.incoming.delete(hash);
      this.clearTransferTimeout(hash);
    }
    this.send({ t: "have", hashes: [...owned] });
    for (const t of this.tracks) {
      if (!owned.has(t.hash)) this.request(t.hash);
    }
  }

  request(hash) {
    if (!HASH_RE.test(hash) || this.owned.has(hash) || this.requested.has(hash)) return;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.requested.add(hash);
    this.send({ t: "need", hash });
    this.watchTransfer(hash);
  }

  /** 在浏览器侧检测断流：不会定时唤醒 DO；只在确实缺失文件时尝试重新取源。 */
  watchTransfer(hash) {
    this.clearTransferTimeout(hash);
    const timer = setTimeout(async () => {
      this.transferTimeouts.delete(hash);
      if (this.stopped || this.owned.has(hash)) return;
      // 可能刚好错过了其他 iframe 的广播。仅在本次重传前再查一次本地
      // OPFS/IDB；如果文件已有完整副本，就不需要再次向公网请求。
      try {
        if (await getAudio(hash)) {
          await this.localFileSaved(hash);
          return;
        }
      } catch (error) { this.onError(error); }
      // 旧源可能已下线，清理不完整缓存，再从当前在线节点重新请求。
      this.requested.delete(hash);
      this.incoming.delete(hash);
      this.request(hash);
    }, 30000);
    this.transferTimeouts.set(hash, timer);
  }

  clearTransferTimeout(hash) {
    clearTimeout(this.transferTimeouts.get(hash));
    this.transferTimeouts.delete(hash);
  }

  /**
   * 等待对应接收方确认某批末尾块。确认可能在等待函数注册前到达，
   * 所以先在 lastAck 中留下高水位，再查是否需要挂起 Promise。
   */
  waitForAck(hash, receiver, index) {
    const key = `${hash}:${receiver}`;
    if ((this.lastAck.get(key) ?? -1) >= index) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ackWaiters.delete(key);
        reject(new Error("接收者没有确认音频窗口，停止本次传输"));
      }, 30000);
      this.ackWaiters.set(key, { index, resolve, reject, timer });
    });
  }

  /** 网络断开时取消所有等待，旧 Promise 不得阻塞下一次连接。 */
  cancelAcks() {
    for (const pending of this.ackWaiters.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("传输连接已关闭"));
    }
    this.ackWaiters.clear();
    this.lastAck.clear();
  }

  /** WebSocket 关闭后按需重建，不使用高频保活/心跳。 */
  connect() {
    if (this.stopped || (this.ws && this.ws.readyState <= WebSocket.OPEN)) return;
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.reconnectDelay = 500;
      this.requested.clear();
      this.incoming.clear();
      for (const timeout of this.transferTimeouts.values()) clearTimeout(timeout);
      this.transferTimeouts.clear();
      this.updateTracks(this.tracks).catch(this.onError);
    };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") this.onControl(e.data);
      else this.onChunk(e.data).catch(this.onError);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.requested.clear();
      this.incoming.clear();
      this.peer = null;
      this.cancelAcks();
      for (const timeout of this.transferTimeouts.values()) clearTimeout(timeout);
      this.transferTimeouts.clear();
      if (this.stopped) return;
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      // 这是浏览器侧断线恢复计时器，不会唤醒任何 DO。
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => {}; // close 会负责重连，避免双重定时器
  }

  async announce(hash) {
    if (!HASH_RE.test(hash) || !(await getAudio(hash))) return;
    this.owned.add(hash);
    this.requested.delete(hash);
    this.incoming.delete(hash);
    this.clearTransferTimeout(hash);
    this.send({ t: "have", hashes: [...this.owned] });
    this.localBus?.postMessage({ t: "saved", hash });
  }

  /**
   * 收到同源兄弟 iframe 保存文件的通知。
   * 不直接信任广播数据，而是校验当前房间的歌单确实引用该摘要，
   * 且共享 OPFS/IndexedDB 已能读取该文件，之后才宣布自己拥有副本。
   */
  async localFileSaved(hash) {
    if (this.stopped || !HASH_RE.test(hash) ||
        !this.tracks.some((track) => track.hash === hash)) return;
    const file = await getAudio(hash);
    if (!file || this.stopped) return;
    const firstSeen = !this.owned.has(hash);
    this.owned.add(hash);
    this.requested.delete(hash);
    this.incoming.delete(hash);
    this.clearTransferTimeout(hash);
    this.send({ t: "have", hashes: [...this.owned] });
    // 播放器先前可能因找不到本地曲目而停在缓冲，直接重新加载。
    if (firstSeen) this.onFile(hash);
  }

  onControl(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.t) {
      case "welcome":
        this.peer = msg.peer;
        break;
      case "ack": {
        const key = `${msg.hash}:${msg.from}`;
        if (!Number.isInteger(msg.index)) break;
        this.lastAck.set(key, Math.max(this.lastAck.get(key) ?? -1, msg.index));
        const pending = this.ackWaiters.get(key);
        if (pending && msg.index >= pending.index) {
          clearTimeout(pending.timer);
          this.ackWaiters.delete(key);
          pending.resolve();
        }
        break;
      }
      case "available":
        for (const hash of msg.hashes || []) {
          if (this.tracks.some((t) => t.hash === hash)) this.request(hash);
        }
        break;
      case "serve":
        this.serve(msg.hash, msg.to).catch(this.onError);
        break;
      case "unavailable":
        this.requested.delete(msg.hash);
        this.clearTransferTimeout(msg.hash);
        break;
      case "done":
        // 内容收集以 total/index 为准。done 只是源端完成发送，不等于文件验收成功。
        break;
      default: break;
    }
  }

  async serve(hash, to) {
    if (!HASH_RE.test(hash) || !this.owned.has(hash) || !this.peer) return;
    const serveKey = `${hash}:${to}`;
    if (this.serving.has(serveKey)) return;
    this.serving.add(serveKey);
    this.lastAck.delete(serveKey);
    try {
    const file = await getAudio(hash);
    if (!file || file.size > MAX_AUDIO_SIZE) return;
    const sent = await sendAudioWithoutAck({
      ws: this.ws, file, hash, from: this.peer, to,
    });
    if (sent) this.send({ t: "done", hash, to });
    } finally {
      this.serving.delete(serveKey);
      this.lastAck.delete(serveKey);
    }
  }

  async onChunk(raw) {
    const { header, bytes } = decodeChunk(raw);
    const t = this.tracks.find((t) => t.hash === header.hash);
    if (!t || t.size > MAX_AUDIO_SIZE || !Number.isSafeInteger(t.size)) return;
    if (header.total !== Math.ceil(t.size / CHUNK_SIZE)) return;
    if (this.owned.has(header.hash)) {
      // 旧请求可能已经在 DO 转发队列里，仍要对分组尾块 ACK，
      // 否则发送者会无谓地等待 30 秒才能停止旧传输。
      if ((header.index + 1) % ACK_WINDOW === 0 || header.index + 1 === header.total) {
        this.send({ t: "ack", hash: header.hash, to: header.from, index: header.index });
      }
      return;
    }
    let rec = this.incoming.get(header.hash);
    if (!rec) {
      rec = { chunks: new Array(header.total), size: 0, complete: false };
      this.incoming.set(header.hash, rec);
    }
    if (rec.complete || rec.chunks[header.index]) return;
    const expected = Math.min(CHUNK_SIZE, t.size - header.index * CHUNK_SIZE);
    if (bytes.byteLength !== expected) return;
    rec.chunks[header.index] = bytes.slice();
    rec.size += bytes.byteLength;
    this.watchTransfer(header.hash);
    if ((header.index + 1) % ACK_WINDOW === 0 || header.index + 1 === header.total) {
      this.send({ t: "ack", hash: header.hash, to: header.from, index: header.index });
    }
    if (rec.size !== t.size || rec.chunks.some((part) => !part)) return;
    rec.complete = true;
    const blob = new Blob(rec.chunks, { type: t.mime || "audio/mpeg" });
    try {
      if ((await digest(blob)) !== header.hash) throw new Error("接收音频的 SHA-256 不一致");
      await putAudio(header.hash, blob);
      this.owned.add(header.hash);
      this.requested.delete(header.hash);
      this.clearTransferTimeout(header.hash);
      await this.announce(header.hash);
      this.onFile(header.hash);
    } catch (err) {
      this.requested.delete(header.hash);
      this.clearTransferTimeout(header.hash);
      this.onError(err);
    } finally {
      this.incoming.delete(header.hash);
    }
  }

  close() {
    this.stopped = true;
    this.localBus?.close();
    this.cancelAcks();
    for (const timeout of this.transferTimeouts.values()) clearTimeout(timeout);
    this.transferTimeouts.clear();
    this.ws?.close();
    this.ws = null;
  }
}
