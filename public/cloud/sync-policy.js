/**
 * 云版音乐同步策略：以连续的原速播放优先，只有播放时间轴发生明确跳变
 * 才同步一次 HTMLAudioElement.currentTime。
 *
 * 音乐不是视频会议：逐秒修改 playbackRate 或硬 seek 会改变人声的音高、
 * 造成节奏波动；尤其是 Safari 的短循环中能听到明显的卡顿。
 */
export function shouldSnapOnCloudUpdate(previous, next, previousTarget, nextTarget, duration) {
  if (!previous || !next || previous.seq === next.seq) return false;
  if (previous.trackId !== next.trackId || previous.playing !== next.playing) return true;
  if (!Number.isFinite(previousTarget) || !Number.isFinite(nextTarget)) return false;
  if (next.loop === "track" && Number.isFinite(duration) && duration > 0) {
    // 原生 audio.loop 已在不断播放：Owlbear 报告「下一轮」时，虽然
    // 房间时间锚点从 12.4 秒变成 0 秒，音频自身并没有发生需要跳转的变化。
    return Math.abs(cloudPhaseDifference(previousTarget, nextTarget,
      duration, true)) > 0.75;
  }
  // 改音量等设置会递增 seq，但并不意味着播放时间轴发生跳变。
  return Math.abs(previousTarget - nextTarget) > 0.75;
}

/** 计算循环曲目的最短相位差，避免 12.3 秒与 0.1 秒被误判成落后 12.2 秒。 */
export function cloudPhaseDifference(actual, target, duration, loop) {
  if (!Number.isFinite(actual) || !Number.isFinite(target)) return 0;
  if (!loop || !Number.isFinite(duration) || duration <= 0) return actual - target;
  const half = duration / 2;
  return ((actual - target + half) % duration + duration) % duration - half;
}

export function initialCloudSeek(target, duration, loop, playing) {
  if (!Number.isFinite(target)) return 0;
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, target);
  // Safari 晚加入时下载可能已经跨越一轮 12 秒短循环。
  // 不应把 currentTime 设为大于时长的值，否则媒体进入 ended/静音状态。
  if (loop === "track" && playing) {
    if (target >= 0 && target < duration) return target;
    return ((target % duration) + duration) % duration;
  }
  return Math.max(0, Math.min(target, duration));
}
