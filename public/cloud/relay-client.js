/**
 * 在 GM、玩家任意浏览器之间同步缺失的歌曲文件。
 *
 * 不做直连 WebRTC；每个字节都从发送者浏览器经过一个 Cloudflare DO，
 * 再到接收者浏览器。与播放同步完全独立。平时 DO WebSocket 无应用心跳。
 *
 * 失败时按整个文件重试，而不是保留不完整文件；收到的音频必须先校验
 * SHA-256 才能进入 OPFS/IndexedDB。最大 64 MiB，单块 256 KiB。
 *
 * 诊断分三层计数：浏览器原始WebSocket消息、二进制协议解析、接收状态机。
 * 特别不能拿DO的forwardedBytes（只证明调用了send）当浏览器实际收包量。
 */
import { CHUNK_SIZE, MAX_AUDIO_SIZE, HASH_RE, decodeChunk, encodeChunk } from "./wire.js";
import { getAudio, putAudio, digest } from "./storage.js";
import { prioritizeTracks } from "./request-priority.js";
import { sendAudioWithoutAck, sendAudioWithAck } from "./audio-sender.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_SIMULTANEOUS_DOWNLOADS = 2;
// 用户主动诊断时使用的保留哈希，不对应任何真实音频。
const PROBE_HASH = "0".repeat(64);

export class RelayClient {
  constructor(roomId, secret, onFile = () => {}, onError = () => {}) {
    this.roomId = roomId;
    this.secret = secret;
    this.onFile = onFile;
    // 只在当前页面内保存最近的诊断事件，不把浏览器错误自动上传到云端。
    // 导出的报告只包含固定类型、数量、时间与歌曲摘要前 10 位。
    this.events = [];
    this.metrics = { requested: 0, receivedBytes: 0, verified: 0,
      sendQueuedBytes: 0, reconnects: 0, unavailable: 0, timeouts: 0,
      receivedFrames: 0, resentFrames: 0, lastChunkIndex: -1,
      // rawBinary*在ws.onmessage入口递增，还没有运行任何音频头校验。
      rawBinaryMessages: 0, rawBinaryBytes: 0, rawBinaryKind: null,
      parsedFrames: 0, rejectedFrames: 0, lastRejectReason: null,
      duplicateFrames: 0, controlMessages: 0,
      timedOutPartialBytes: 0, timedOutPartialChunks: 0 };
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
    this.priorityTrackId = null;
    this.unavailable = new Set();
    this.updateGeneration = 0;
    this.probePending = null;
    this.lastProbe = null;
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

  /** 在收包中途明确记录拒绝原因。只留白名单原因，不记录任何原始字节。 */
  rejectFrame(reason) {
    this.metrics.rejectedFrames++;
    this.metrics.lastRejectReason = reason;
    this.note("frame-rejected", { reason });
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
      lastProbe: this.lastProbe,
      events: this.events.slice(-25),
    };
  }

  /**
   * 单次人工触发的链路诊断：DO依次回小型文本和256KiB二进制数据。
   * 这能检查readyState为OPEN的连接是否真的还能收消息；不会周期轮询。
   * 只有两种消息都到达才能判断二进制下行链路确实活跃。
   */
  probeTransfer(timeoutMs = 4500) {
    if (this.probePending) return this.probePending.promise;
    if (this.stopped || this.ws?.readyState !== WebSocket.OPEN || !this.peer) {
      this.lastProbe = { textAck: false, binaryAck: false, elapsedMs: null };
      return Promise.resolve(this.lastProbe);
    }
    const nonce = [...crypto.getRandomValues(new Uint8Array(6))]
      .map((n) => n.toString(16).padStart(2, "0")).join("");
    const pending = { nonce, textAck: false, binaryAck: false,
      startedAt: Date.now(), resolve: null, timer: null, promise: null };
    pending.promise = new Promise((resolve) => { pending.resolve = resolve; });
    this.probePending = pending;
    pending.timer = setTimeout(() => this.finishProbe(), timeoutMs);
    this.send({ t: "probe", nonce });
    return pending.promise;
  }

  finishProbe() {
    const p = this.probePending;
    if (!p) return;
    clearTimeout(p.timer);
    this.probePending = null;
    this.lastProbe = { textAck: p.textAck, binaryAck: p.binaryAck,
      elapsedMs: Date.now() - p.startedAt };
    p.resolve(this.lastProbe);
  }

  url() {
    const wsScheme = location.protocol === "https:" ? "wss:" : "ws:";
    return `${wsScheme}//${location.host}/relay?room=${encodeURIComponent(this.roomId)}&key=${this.secret}`;
  }

  send(data) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(data));
  }

  async updateTracks(tracks, currentTrackId = this.priorityTrackId) {
    const generation = ++this.updateGeneration;
    this.priorityTrackId = currentTrackId;
    const ordered = prioritizeTracks(
      (tracks || []).filter((t) => HASH_RE.test(t.hash)), currentTrackId
    );
    const owned = new Set();
    for (const t of ordered) {
      if (await getAudio(t.hash)) owned.add(t.hash);
    }
    // 多次 onMetadataChange 可能并行扫描 OPFS。过期异步结果绝不可
    // 把刚加入歌单的歌曲、目前优先的歌曲顺序覆盖回旧状态。
    if (this.stopped || generation !== this.updateGeneration) return;
    this.tracks = ordered;
    this.owned = new Set([
      ...owned, ...[...this.owned].filter((hash) => ordered.some((t) => t.hash === hash)),
    ]);
    const active = new Set(ordered.map((t) => t.hash));
    for (const hash of [...this.requested]) {
      if (!active.has(hash)) {
        this.requested.delete(hash);
        this.incoming.delete(hash);
        this.clearTransferTimeout(hash);
      }
    }
    // 曲目状态更新时若文件早已由兄弟 iframe 保存，则清除仍在等待的
    // 请求和 30 秒重试定时器，避免本地已有文件仍反复唤醒 DO。
    for (const hash of owned) {
      this.requested.delete(hash);
      this.incoming.delete(hash);
      this.clearTransferTimeout(hash);
    }
    this.send({ t: "have", hashes: [...this.owned] });
    this.pumpRequests();
  }

  pumpRequests() {
    if (this.stopped || this.ws?.readyState !== WebSocket.OPEN) return;
    // 仅同时下载当前歌曲和最多一首预取歌曲，防止大歌单抢占
    // 刚加入的玩家有限的网络带宽，也降低 DO 的瞬时传输请求数。
    for (const track of this.tracks) {
      if (this.requested.size >= MAX_SIMULTANEOUS_DOWNLOADS) break;
      if (this.unavailable.has(track.hash)) continue;
      this.request(track.hash);
    }
  }

  request(hash) {
    if (!HASH_RE.test(hash) || this.owned.has(hash) || this.requested.has(hash) ||
        this.unavailable.has(hash) || this.requested.size >= MAX_SIMULTANEOUS_DOWNLOADS) return;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.requested.add(hash);
    this.metrics.requested++;
    this.note("request", { hash: hash.slice(0, 10) });
    // 协商仅影响本次文件发送，旧版 GM 看不懂此字段仍沿用原发送流程。
    this.send({ t: "need", hash, flowControl: "ack-v1" });
    this.watchTransfer(hash);
  }

  /** 在浏览器侧检测断流：不会定时唤醒 DO；只在确实缺失文件时尝试重新取源。 */
  watchTransfer(hash) {
    this.clearTransferTimeout(hash);
    const timer = setTimeout(async () => {
      this.transferTimeouts.delete(hash);
      if (this.stopped || this.owned.has(hash)) return;
      this.metrics.timeouts++;
      // 旧版超时会清空 incoming，导致报告里「当前已收0B」掩盖
      // 本次超时前实际收到的部分数据。记录清空之前的分块数量。
      const partial = this.incoming.get(hash);
      if (partial) {
        this.metrics.timedOutPartialBytes += partial.size;
        this.metrics.timedOutPartialChunks += partial.chunks.filter(Boolean).length;
      }
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
  waitForAck(hash, receiver, index, timeoutMs = 30000) {
    const key = `${hash}:${receiver}`;
    if ((this.lastAck.get(key) ?? -1) >= index) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ackWaiters.delete(key);
        reject(new Error("接收者没有确认音频窗口，停止本次传输"));
      }, timeoutMs);
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
      this.unavailable.clear();
      this.requested.clear();
      this.incoming.clear();
      for (const timeout of this.transferTimeouts.values()) clearTimeout(timeout);
      this.transferTimeouts.clear();
      this.updateTracks(this.tracks, this.priorityTrackId).catch(this.onError);
    };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") {
        this.metrics.controlMessages++;
        this.onControl(e.data);
        return;
      }
      // 此处计数独立于解析成败。若DO已转发几十MB而rawBinaryMessages=0，
      // 就要检查Cloudflare下行/浏览器是否真正派发message事件。
      this.metrics.rawBinaryMessages++;
      this.metrics.rawBinaryKind = e.data instanceof ArrayBuffer ? "arraybuffer" :
        e.data instanceof Blob ? "blob" : "other";
      this.metrics.rawBinaryBytes += e.data?.byteLength ?? e.data?.size ?? 0;
      this.onChunk(e.data).catch(this.onError);
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.finishProbe();
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
    this.pumpRequests();
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
    this.pumpRequests();
  }

  onControl(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.t) {
      case "welcome":
        this.peer = msg.peer;
        this.note("identified", { peer: this.peer?.slice(0, 12) });
        break;
      case "probe-ack":
        if (this.probePending?.nonce === msg.nonce) {
          this.probePending.textAck = true;
          if (this.probePending.binaryAck) this.finishProbe();
        }
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
          if (this.tracks.some((t) => t.hash === hash)) this.unavailable.delete(hash);
        }
        this.pumpRequests();
        break;
      case "serve":
        this.serve(msg.hash, msg.to, msg.flowControl).catch(this.onError);
        break;
      case "unavailable":
        this.metrics.unavailable++;
        this.note("unavailable", { hash: String(msg.hash).slice(0, 10) });
        this.requested.delete(msg.hash);
        this.clearTransferTimeout(msg.hash);
        this.unavailable.add(msg.hash);
        this.pumpRequests();
        break;
      case "done":
        // 内容收集以 total/index 为准。done 只是源端完成发送，不等于文件验收成功。
        break;
      default: break;
    }
  }

  async serve(hash, to, flowControl = null) {
    if (!HASH_RE.test(hash) || !this.owned.has(hash) || !this.peer) return;
    const serveKey = `${hash}:${to}`;
    if (this.serving.has(serveKey)) return;
    this.serving.add(serveKey);
    this.lastAck.delete(serveKey);
    try {
    const file = await getAudio(hash);
    if (!file || file.size > MAX_AUDIO_SIZE) return;
    const options = { ws: this.ws, file, hash, from: this.peer, to };
    // 兼容升级中的其他成员：只有新玩家明确声明支持逐块确认，才启用它；
    // 老玩家仍用v3.3.1无需ACK的发送方式，不会因新版GM而卡住。
    const sent = flowControl === "ack-v1"
      ? await sendAudioWithAck({ ...options,
        waitForAck: (index, ms) => this.waitForAck(hash, to, index, ms),
        onRetry: (index) => {
          this.metrics.resentFrames++;
          this.note("resend", { hash: hash.slice(0, 10), index });
        },
      })
      : await sendAudioWithoutAck(options);
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
      // 通常 binaryType=arraybuffer，但部分WebView/恢复场景仍可能给Blob。
      // 不应因一种合法二进制承载类型就把实际到达的数据判成坏帧。
      if (raw instanceof Blob) raw = await raw.arrayBuffer();
      decoded = decodeChunk(raw);
    } catch (error) {
      // 切勿把原始二进制帧/房间地址写入诊断，只标识失败阶段。
      this.rejectFrame("invalid-frame");
      this.note("failure", { phase: "wire", reason: "invalid-frame" });
      throw error;
    }
    const { header, bytes } = decoded;
    if (header.hash === PROBE_HASH) {
      // 独立于音频歌单的探针，不能把它当成未登记曲目拒绝。
      const p = this.probePending;
      if (p?.nonce === header.probe && header.to === this.peer &&
          header.from === this.peer && header.total === 1 && header.index === 0 &&
          bytes.length === CHUNK_SIZE && bytes[0] === 0x5a &&
          bytes[Math.floor(CHUNK_SIZE / 2)] === 0x5a && bytes[CHUNK_SIZE - 1] === 0x5a) {
        p.binaryAck = true;
        if (p.textAck) this.finishProbe();
      }
      return;
    }
    this.metrics.parsedFrames++;
    const t = this.tracks.find((t) => t.hash === header.hash);
    if (!t) return this.rejectFrame("untracked-hash");
    if (t.size > MAX_AUDIO_SIZE || !Number.isSafeInteger(t.size)) {
      return this.rejectFrame("invalid-track-size");
    }
    if (header.total !== Math.ceil(t.size / CHUNK_SIZE)) {
      return this.rejectFrame("chunk-total-mismatch");
    }
    if (this.owned.has(header.hash)) {
      // 文件可能刚被兄弟 iframe 缓存。仍对每块重发 ACK，避免
      // 新版发送者因第一块已存在便永远收不到确认。
      this.send({ t: "ack", hash: header.hash, to: header.from, index: header.index });
      return;
    }
    let rec = this.incoming.get(header.hash);
    if (!rec) {
      rec = { chunks: new Array(header.total), size: 0, complete: false };
      this.incoming.set(header.hash, rec);
    }
    if (rec.complete || rec.chunks[header.index]) {
      this.metrics.duplicateFrames++;
      // ACK 在网络中丢失时，发送者会重发同一块。必须重发确认，
      // 否则发送者永远不敢继续发送下一块，重现旧版「8块处卡死」。
      this.send({ t: "ack", hash: header.hash, to: header.from, index: header.index });
      return;
    }
    const expected = Math.min(CHUNK_SIZE, t.size - header.index * CHUNK_SIZE);
    if (bytes.byteLength !== expected) return this.rejectFrame("chunk-size-mismatch");
    rec.chunks[header.index] = bytes.slice();
    rec.size += bytes.byteLength;
    this.metrics.receivedBytes += bytes.byteLength;
    this.metrics.receivedFrames++;
    this.metrics.lastChunkIndex = header.index;
    this.watchTransfer(header.hash);
    // 新发送者每个块均等待ACK；旧发送者忽略新增的确认，保证互操作。
    this.send({ t: "ack", hash: header.hash, to: header.from, index: header.index });
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
    this.finishProbe();
    this.updateGeneration++;
    this.localBus?.close();
    this.cancelAcks();
    for (const timeout of this.transferTimeouts.values()) clearTimeout(timeout);
    this.transferTimeouts.clear();
    this.ws?.close();
    this.ws = null;
  }
}
