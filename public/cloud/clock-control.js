/**
 * 云端时间表的本地闭环纠偏器（纯函数）。
 *
 * GM 只负责发布绝对时间表，浏览器不能以自己「上一首何时结束」来决定
 * 下一首何时开始。每个设备至少在本地连续比较：
 *
 *   误差 = 实际 HTMLAudioElement.currentTime - 共享时间表期望的位置
 *
 * 理想值是 0。小误差忽略，持续的小误差通过极轻微的速率控制消除，
 * 只有长时间严重脱节，才在受到冷却限制时一次性校准。此计算不依赖
 * 任何 Cloudflare 网络往返，不会因为广播延迟反复暂停/重建音频。
 *
 * 注意：currentTime 不是扬声器真正输出采样时刻；平台输出缓冲、
 * 蓝牙耳机延迟都可能造成几十到几百毫秒固定偏移。因此这里保证的是
 * 可测量的媒体播放时间轴不累计误差，不宣称 10ms 声学同步精度。
 */
import { cloudPhaseDifference } from "./sync-policy.js";

export const DRIFT_DEADBAND_SECONDS = 0.10;
export const DRIFT_RATE_LIMIT = 0.015;
export const LARGE_DRIFT_SECONDS = 2.5;
export const LARGE_DRIFT_PERSIST_MS = 6000;
export const SEEK_COOLDOWN_MS = 20_000;

/**
 * @param {{
 *   actual:number, expected:number, duration:number, cyclic:boolean,
 *   now:number, largeSince:number, lastSeek:number
 * }} sample
 * @returns {{
 *  drift:number, rate:number, seek:boolean, nextLargeSince:number,
 *  mode:string
 * }}
 */
export function computeClockCorrection(sample) {
  const { actual, expected, duration, cyclic, now, lastSeek } = sample;
  const drift = cloudPhaseDifference(actual, expected, duration, cyclic);
  const magnitude = Math.abs(drift);

  // 抖动和音频 currentTime 的有限更新精度不应每 200ms 引起播放速率变化。
  if (magnitude < DRIFT_DEADBAND_SECONDS) {
    return { drift, rate: 1, seek: false, nextLargeSince: 0, mode: "aligned" };
  }

  if (magnitude >= LARGE_DRIFT_SECONDS) {
    const nextLargeSince = sample.largeSince || now;
    // 不允许「每 12 秒单曲循环一圈就 seek 3 次」。
    // 与上次 seek 最短间隔 20 秒，而且要观察 6 秒稳定的大偏差。
    const seek = now - nextLargeSince >= LARGE_DRIFT_PERSIST_MS &&
      now - (lastSeek || 0) >= SEEK_COOLDOWN_MS;
    return { drift, rate: 1, seek,
      nextLargeSince: seek ? 0 : nextLargeSince,
      mode: seek ? "recover" : "large-drift-observing" };
  }

  // 不修改当前播放位置，也不销毁音频缓冲，只轻柔地调整频率追赶。
  // preservesPitch 由调用方支持时启用，最大调速 1.5%。
  const correction = Math.max(-DRIFT_RATE_LIMIT,
    Math.min(DRIFT_RATE_LIMIT, -drift * 0.045));
  return {
    drift, rate: Number((1 + correction).toFixed(3)),
    seek: false, nextLargeSince: 0, mode: "fine-correction",
  };
}

/** 统计有限数量的时钟样本，供本人诊断/GM 调试，而不是无限上报云端。 */
export class DriftMonitor {
  constructor(capacity = 120) {
    this.capacity = capacity;
    this.samples = [];
    this.last = null;
    this.recoveries = 0;
  }

  push(driftSeconds, mode, time = Date.now()) {
    if (!Number.isFinite(driftSeconds)) return;
    this.last = { time, driftMs: Math.round(driftSeconds * 1000), mode };
    this.samples.push(this.last);
    if (this.samples.length > this.capacity) this.samples.shift();
    if (mode === "recover") this.recoveries++;
  }

  snapshot() {
    if (!this.samples.length) return { samples: 0, lastDriftMs: null,
      meanAbsDriftMs: null, maxAbsDriftMs: null, recoveries: this.recoveries };
    const absolute = this.samples.map((s) => Math.abs(s.driftMs));
    return {
      samples: absolute.length,
      lastDriftMs: this.last.driftMs,
      meanAbsDriftMs: Math.round(
        absolute.reduce((sum, n) => sum + n, 0) / absolute.length),
      maxAbsDriftMs: Math.max(...absolute),
      recoveries: this.recoveries,
      mode: this.last.mode,
    };
  }
}
