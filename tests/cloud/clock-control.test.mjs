import test from "node:test";
import assert from "node:assert/strict";
import { computeClockCorrection, DriftMonitor } from "../../public/cloud/clock-control.js";

const baseline = {
  actual: 5, expected: 5, duration: 12.4,
  cyclic: true, now: 100_000, largeSince: 0, lastSeek: 0,
};

test("每轮 12.4 秒到 0 秒的边界属于同一个全局时刻，不会硬跳", () => {
  const state = computeClockCorrection({ ...baseline,
    actual: 0.04, expected: 12.39 });
  assert.ok(Math.abs(state.drift - 0.05) < 0.000001);
  assert.equal(state.mode, "aligned");
  assert.equal(state.rate, 1);
  assert.equal(state.seek, false);
});

test("100~400ms 偏移用温和闭环慢慢消除，越接近目标调速越小", () => {
  const early = computeClockCorrection({ ...baseline, actual: 5.3 });
  const late = computeClockCorrection({ ...baseline, actual: 4.7 });
  assert.ok(early.rate >= 0.985 && early.rate < 1);
  assert.ok(late.rate <= 1.015 && late.rate > 1);
  assert.equal(early.seek, false);
  assert.equal(late.seek, false);
  const nearly = computeClockCorrection({ ...baseline, actual: 5.05 });
  assert.equal(nearly.rate, 1);
});

test("大误差只有持续6秒且离上次seek至少20秒才允许一次恢复", () => {
  const sample = { ...baseline, actual: 9, cyclic: false };
  const first = computeClockCorrection(sample);
  assert.equal(first.seek, false);
  const tooSoon = computeClockCorrection({ ...sample,
    now: sample.now + 5000, largeSince: first.nextLargeSince });
  assert.equal(tooSoon.seek, false);
  const recovered = computeClockCorrection({ ...sample,
    now: sample.now + 6001, largeSince: first.nextLargeSince });
  assert.equal(recovered.seek, true);
  const cooling = computeClockCorrection({ ...sample,
    now: sample.now + 11000, largeSince: sample.now + 6002, lastSeek: sample.now + 6001 });
  assert.equal(cooling.seek, false);
});

test("严重相位漂移只与全局时间表比较，浏览器之前循环多少圈无关", () => {
  const monitor = new DriftMonitor(4);
  for (const x of [0.03, 0.25, -0.4, 0.06, -0.08]) {
    monitor.push(x, "fine-correction");
  }
  const s = monitor.snapshot();
  assert.equal(s.samples, 4);
  assert.equal(s.lastDriftMs, -80);
  assert.equal(s.maxAbsDriftMs, 400);
  assert.equal(s.recoveries, 0);
});

test("模拟15分钟手机音频硬件漂移：本机持续闭环且不会按循环次数累计延迟", () => {
  // 假设手机音频振荡器比权威时间快 300 ppm（真实设备常见偏差要小得多），
  // 从第 0 秒启动一首 12.4 秒循环歌曲。每 200ms 控制一次播放速率。
  // 这是控制器的确定性模拟，不是任何具体手机的实测声卡延迟。
  let now = 100_000;
  let position = 0;
  let rate = 1;
  let largeSince = 0;
  let lastSeek = 0;
  let maxDriftAfterStartup = 0;
  let seekCount = 0;
  const period = 12.4;
  for (let i = 0; i < 4500; i++) {
    const elapsed = i * 0.2;
    now = 100_000 + i * 200;
    const expected = elapsed % period;
    const update = computeClockCorrection({
      actual: position, expected, duration: period, cyclic: true,
      now, largeSince, lastSeek,
    });
    largeSince = update.nextLargeSince;
    rate = update.rate;
    if (update.seek) {
      position = expected;
      lastSeek = now;
      seekCount++;
    }
    if (i > 100) maxDriftAfterStartup = Math.max(
      maxDriftAfterStartup, Math.abs(update.drift));
    position = (position + 0.2 * 1.0003 * rate) % period;
  }
  assert.equal(seekCount, 0, "正常微小硬件速差不应触发任何硬跳");
  assert.ok(maxDriftAfterStartup < 0.25,
    `15分钟不允许越漂越远，实际最大偏差 ${maxDriftAfterStartup.toFixed(3)} 秒`);
});
