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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    this.stopped = false;
    this.reconnectDelay = 500;
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
    this.send({ t: "have", hashes: [...this.owned] });
  }

  onControl(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.t) {
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
        break;
      case "done":
        // 内容收集以 total/index 为准。done 只是源端完成发送，不等于文件验收成功。
        break;
      default: break;
    }
  }

  async serve(hash, to) {
    if (!HASH_RE.test(hash) || !this.owned.has(hash)) return;
    const file = await getAudio(hash);
    if (!file || file.size > MAX_AUDIO_SIZE) return;
    const count = Math.ceil(file.size / CHUNK_SIZE);
    for (let index = 0; index < count; index++) {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const block = new Uint8Array(await file.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE).arrayBuffer());
      // 限制浏览器待发送队列，避免一次把几十兆全部排进内存。
      while (ws.bufferedAmount > 2 * 1024 * 1024) {
        if (ws.readyState !== WebSocket.OPEN) return;
        await sleep(25);
      }
      ws.send(encodeChunk({ to, hash, index, total: count }, block));
    }
    this.send({ t: "done", hash, to });
  }

  async onChunk(raw) {
    const { header, bytes } = decodeChunk(raw);
    const t = this.tracks.find((t) => t.hash === header.hash);
    if (!t || t.size > MAX_AUDIO_SIZE || !Number.isSafeInteger(t.size)) return;
    if (header.total !== Math.ceil(t.size / CHUNK_SIZE)) return;
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
    if (rec.size !== t.size || rec.chunks.some((part) => !part)) return;
    rec.complete = true;
    const blob = new Blob(rec.chunks, { type: t.mime || "audio/mpeg" });
    try {
      if ((await digest(blob)) !== header.hash) throw new Error("接收音频的 SHA-256 不一致");
      await putAudio(header.hash, blob);
      this.owned.add(header.hash);
      this.requested.delete(header.hash);
      await this.announce(header.hash);
      this.onFile(header.hash);
    } catch (err) {
      this.requested.delete(header.hash);
      this.onError(err);
    } finally {
      this.incoming.delete(header.hash);
    }
  }

  close() {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }
}
