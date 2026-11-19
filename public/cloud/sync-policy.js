/**
 * 云版音乐同步策略：以连续的原速播放优先，只有播放时间轴发生明确跳变
 * 才同步一次 HTMLAudioElement.currentTime。
 *
 * 音乐不是视频会议：逐秒修改 playbackRate 或硬 seek 会改变人声的音高、
 * 造成节奏波动；尤其是 Safari 的短循环中能听到明显的卡顿。
 */
export function shouldSnapOnCloudUpdate(previous, next, previousTarget, nextTarget) {
  if (!previous || !next || previous.seq === next.seq) return false;
  if (previous.trackId !== next.trackId || previous.playing !== next.playing) return true;
  if (!Number.isFinite(previousTarget) || !Number.isFinite(nextTarget)) return false;
  // 改音量等设置会递增 seq，但并不意味着播放时间轴发生跳变。
  return Math.abs(previousTarget - nextTarget) > 0.75;
}

export function initialCloudSeek(target, duration, loop, playing) {
  if (!Number.isFinite(target)) return 0;
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, target);
  // Safari 晚加入时下载可能已经跨越一轮 12 秒短循环。
  // 不应把 currentTime 设为大于时长的值，否则媒体进入 ended/静音状态。
  if (loop === "track" && playing) return ((target % duration) + duration) % duration;
  return Math.max(0, Math.min(target, duration));
}
