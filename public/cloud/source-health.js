/**
 * 歌单结构与本地原文件校验。不能把「某个 GM 本机没缓存」等同于
 * 「全房间无音源」；前者可由其他在线成员补齐。
 */
import { HASH_RE, MAX_AUDIO_SIZE } from "./wire.js";

export function validatePlaylist(state) {
  if (!state || !Array.isArray(state.playlist)) throw new Error("房间歌单结构不完整");
  const ids = new Set();
  for (const [i, track] of state.playlist.entries()) {
    if (!track || typeof track.id !== "string" || !track.id ||
        ids.has(track.id) || !HASH_RE.test(track.hash) ||
        !Number.isSafeInteger(track.size) || track.size <= 0 ||
        track.size > MAX_AUDIO_SIZE || typeof track.title !== "string" ||
        !track.title.trim()) {
      throw new Error(`房间歌单第 ${i + 1} 首元数据损坏；请从完整 ZIP 备份恢复`);
    }
    ids.add(track.id);
  }
  if (state.playback?.trackId &&
      !ids.has(state.playback.trackId)) {
    throw new Error("房间歌单引用了不存在的播放曲目");
  }
  return true;
}

/**
 * 本机可读性和 DO 当前在线音源是两份证据，不能互相替代：
 * - localMissing 只表示本机没有读到“完整且哈希正确”的副本；
 * - fetching 只是 need 已发送，并不证明远程节点已响应或开始送块；
 * - unavailable 是 DO 查询当时没有已登记的在线持有者，并非永久丢失；
 * - transferFailed 是另一类错误：来源可能在线，但传输/保存失败。
 *
 * DO 没有离线设备的持久库存，故不能宣称文件永久丢失。所有提示均明确
 * 限定当前本机、当前在线连接或已经观察到的传输结果。
 */
export function describeLocalAudio(hash, health = {}) {
  if (!hash) return null;
  const invalid = (health.corrupt || []).find((entry) => entry.hash === hash);
  if (invalid) {
    if (invalid.reason === "read-failed") {
      return { status: "storage-error", label: "本机文件读取异常" };
    }
    return { status: "corrupt", label: "本机缓存校验不通过" };
  }
  if ((health.transferFailed || []).includes(hash)) {
    return { status: "transfer-error", label: "传输失败 · 请检查网络" };
  }
  if ((health.unavailable || []).includes(hash)) {
    return { status: "offline", label: "当前无在线音源 · 可补传" };
  }
  if ((health.fetching || []).includes(hash)) {
    return { status: "fetching", label: "已请求音源 · 尚未完成" };
  }
  if ((health.localMissing || []).includes(hash)) {
    return { status: "pending", label: "本机未检出有效缓存" };
  }
  return null;
}

export async function verifyCachedAudio(track, read, hashFile) {
  try {
    const blob = await read(track.hash);
    if (!blob) return { valid: false, reason: "missing" };
    if (blob.size !== track.size) return { valid: false, reason: "size-mismatch" };
    if ((await hashFile(blob)) !== track.hash) {
      return { valid: false, reason: "hash-mismatch" };
    }
    return { valid: true, reason: null };
  } catch {
    return { valid: false, reason: "read-failed" };
  }
}
