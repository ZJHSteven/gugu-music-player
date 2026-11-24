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
 * 每个浏览器独立保存原文件。手机本地没有缓存并不代表歌曲损坏，
 * 同账号电脑 GM 也只是另一个可向 DO 提供文件的在线来源。
 */
export function describeLocalAudio(hash, health = {}) {
  if (!hash) return null;
  if ((health.corrupt || []).some((entry) => entry.hash === hash)) {
    return { status: "corrupt", label: "本机缓存校验异常" };
  }
  if ((health.fetching || []).includes(hash)) {
    return { status: "fetching", label: "正在同步" };
  }
  if ((health.unavailable || []).includes(hash)) {
    return { status: "offline", label: "等待音源设备上线" };
  }
  if ((health.localMissing || []).includes(hash)) {
    return { status: "pending", label: "本机待同步" };
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
