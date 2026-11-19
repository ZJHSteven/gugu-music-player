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
    // 只在当前页面内保存最近的诊断事件，不把浏览器错误自动上传到云端。
    // 导出的报告只包含固定类型、数量、时间与歌曲摘要前 10 位。
    this.events = [];
    this.metrics = { requested: 0, receivedBytes: 0, verified: 0,
      sendQueuedBytes: 0, reconnects: 0, unavailable: 0, timeouts: 0 };
    this.onError = (error) => {
      this.note("error", { name: String(error?.name || "Error").slice(0, 35) });
      onError(error);
    };
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

  note(type, fields = {}) {
    this.events.push({ at: new Date().toISOString(), type, ...fields });
    if (this.events.length > 50) this.events.shift();
  }

  /** 供普通玩家一键复制的匿名诊断，不包含 roomId、secret、完整 hash。 */
  diagnostics() {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      socketState: this.ws?.readyState ?? 3,
      peer: this.peer?.slice(0, 12) || null,
      bufferedSendBytes: this.ws?.bufferedAmount || 0,
      ownedCount: this.owned.size,
      requestedCount: this.requested.size,
      files: this.tracks.map((t) => {
        const rec = this.incoming.get(t.hash);
        return {
          hash: t.hash.slice(0, 10),
          expectedBytes: t.size,
          cached: this.owned.has(t.hash),
          requested: this.requested.has(t.hash),
          receivedBytes: rec?.size || 0,
          totalChunks: rec?.chunks.length || Math.ceil(t.size / CHUNK_SIZE),
          receivedChunks: rec?.chunks.filter(Boolean).length || 0,
        };
      }),
      ...this.metrics,
      events: this.events.slice(-25),
    };
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
    this.metrics.requested++;
    this.note("request", { hash: hash.slice(0, 10) });
    this.send({ t: "need", hash });
    this.watchTransfer(hash);
  }

  /** 在浏览器侧检测断流：不会定时唤醒 DO；只在确实缺失文件时尝试重新取源。 */
  watchTransfer(hash) {
    this.clearTransferTimeout(hash);
    const timer = setTimeout(async () => {
      this.transferTimeouts.delete(hash);
      if (this.stopped || this.owned.has(hash)) return;
      this.metrics.timeouts++;
      this.note("timeout", { hash: hash.slice(0, 10) });
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
      this.note("connected");
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
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.metrics.reconnects++;
      this.note("disconnected", { code: event?.code || 0 });
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
    ws.onerror = () => {
      // 错误事件往往没有可读 message，仍要留下发生时间给诊断报告。
      this.note("socket-error");
    };
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
        this.note("identified", { peer: this.peer?.slice(0, 12) });
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
        this.metrics.unavailable++;
        this.note("unavailable", { hash: String(msg.hash).slice(0, 10) });
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
    if (sent) {
      this.metrics.sendQueuedBytes += file.size;
      this.note("sent-queued", { hash: hash.slice(0, 10),
        to: to.slice(0, 12), bytes: file.size });
      this.send({ t: "done", hash, to });
    }
    } finally {
      this.serving.delete(serveKey);
      this.lastAck.delete(serveKey);
    }
  }

  async onChunk(raw) {
    let decoded;
    try {
      decoded = decodeChunk(raw);
    } catch (error) {
      // 切勿把原始二进制帧/房间地址写入诊断，只标识失败阶段。
      this.note("failure", { phase: "wire", reason: "invalid-frame" });
      throw error;
    }
    const { header, bytes } = decoded;
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
    this.metrics.receivedBytes += bytes.byteLength;
    this.watchTransfer(header.hash);
    if ((header.index + 1) % ACK_WINDOW === 0 || header.index + 1 === header.total) {
      this.send({ t: "ack", hash: header.hash, to: header.from, index: header.index });
    }
    if (rec.size !== t.size || rec.chunks.some((part) => !part)) return;
    rec.complete = true;
    const blob = new Blob(rec.chunks, { type: t.mime || "audio/mpeg" });
    let phase = "integrity";
    try {
      if ((await digest(blob)) !== header.hash) {
        const error = new Error("接收音频的 SHA-256 不一致");
        error.code = "HASH_MISMATCH";
        throw error;
      }
      phase = "storage";
      // 保存目标可能是 OPFS、IndexedDB 或受限隐私模式下的临时内存。
      // 每一种都必须先完成摘要校验，随后才允许宣称文件可用。
      const storedIn = await putAudio(header.hash, blob);
      this.owned.add(header.hash);
      this.requested.delete(header.hash);
      this.clearTransferTimeout(header.hash);
      await this.announce(header.hash);
      phase = "notification";
      // DO 可区分“服务器转发了字节”和“接收端校验并保存成功”。
      // 这依旧不等于实际已经听到声音，播放错误由本地音频诊断单独记录。
      this.send({ t: "verified", hash: header.hash });
      this.metrics.verified++;
      this.note("verified", { hash: header.hash.slice(0, 10),
        bytes: blob.size, storage: storedIn });
      this.onFile(header.hash);
    } catch (err) {
      // 原先诊断只有「Error」，即使9/9块已收到也无法区分
      // 摘要不一致、两类持久存储拒绝与后续通知失败。
      this.note("failure", {
        hash: header.hash.slice(0, 10),
        phase,
        reason: err?.code === "HASH_MISMATCH" ? "hash-mismatch" :
          phase === "storage" ? "storage-failed" : "processing-failed",
      });
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
