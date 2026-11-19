/**
 * 迟到的玩家应先拿到正在播的歌曲，再预取歌单剩余曲目。
 * 只改变音频整文件请求顺序，不冒称提供 MP3/FLAC 的字节级 Range 流播。
 */
export function prioritizeTracks(tracks, currentTrackId) {
  const list = [...(tracks || [])];
  const index = list.findIndex((track) => track.id === currentTrackId);
  if (index <= 0) return list;
  return [list[index], ...list.slice(0, index), ...list.slice(index + 1)];
}
