/**
 * 音频 WebSocket 二进制消息编码。
 *
 * 一条消息由 4 字节无符号大端 JSON 头长度 + UTF-8 JSON 头 + 原始音频块构成。
 * JSON 头只含目标节点、SHA-256、块序号/总数，DO 读取头后把原始字节转给目标，
 * 从不拼接整首音频，也不解码/储存音频内容。
 */
export const CHUNK_SIZE = 256 * 1024;
export const MAX_AUDIO_SIZE = 64 * 1024 * 1024;
export const HASH_RE = /^[a-f0-9]{64}$/;
export const PEER_RE = /^[a-f0-9-]{36}$/;
const MAX_HEADER = 512;
const utf8 = new TextEncoder();
const decoder = new TextDecoder();

export function encodeChunk(header, bytes) {
  const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (body.byteLength > CHUNK_SIZE || !body.byteLength) throw new Error("音频块长度不正确");
  const title = utf8.encode(JSON.stringify(header));
  if (title.byteLength > MAX_HEADER) throw new Error("帧头太长");
  const frame = new Uint8Array(4 + title.byteLength + body.byteLength);
  new DataView(frame.buffer).setUint32(0, title.byteLength, false);
  frame.set(title, 4);
  frame.set(body, 4 + title.byteLength);
  return frame.buffer;
}

/** 对于 DO 只读取头，接收者还会把末尾二进制块交给内容校验程序。 */
export function decodeChunk(input) {
  const raw = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (raw.byteLength < 6 || raw.byteLength > CHUNK_SIZE + MAX_HEADER + 4) {
    throw new Error("非法二进制帧大小");
  }
  const n = new DataView(raw.buffer, raw.byteOffset, 4).getUint32(0, false);
  if (!n || n > MAX_HEADER || raw.byteLength - 4 - n < 1) throw new Error("帧头长度不正确");
  const head = JSON.parse(decoder.decode(raw.subarray(4, 4 + n)));
  if (
    !HASH_RE.test(head.hash) || !PEER_RE.test(head.to) ||
    !Number.isInteger(head.index) || !Number.isInteger(head.total) ||
    head.index < 0 || head.total <= 0 || head.index >= head.total ||
    head.total > Math.ceil(MAX_AUDIO_SIZE / CHUNK_SIZE)
  ) throw new Error("二进制帧元数据非法");
  return { header: head, bytes: raw.subarray(4 + n) };
}
