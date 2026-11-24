/**
 * 迟到的玩家应先拿到正在播的歌曲，再预取歌单剩余曲目。
 * 优先当前曲目，其后按预计播放方向预取接下来的歌曲，历史曲目最后补齐。
 * 只改变音频整文件请求顺序，不冒称提供 MP3/FLAC 的字节级 Range 流播。
 */
export function prioritizeTracks(tracks, currentTrackId) {
  const list = [...(tracks || [])];
  const index = list.findIndex((track) => track.id === currentTrackId);
  if (index <= 0) return list;
  return [list[index], ...list.slice(index + 1), ...list.slice(0, index)];
}
