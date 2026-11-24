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
