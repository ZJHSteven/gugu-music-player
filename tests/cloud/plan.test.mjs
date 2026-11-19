import test from "node:test";
import assert from "node:assert/strict";
import { canPredictPlayback, projectPlayback, upcomingTrack } from "../../public/cloud/plan.js";

function plan(loop = "list") {
  return {
    playlist: [
      { id: "a", duration: 12.4 },
      { id: "b", duration: 7 },
      { id: "c", duration: 23.6 },
    ],
    playback: { trackId: "a", playing: true, anchor: 100_000,
      position: 0, seq: 9, loop, volume: 0.8 },
  };
}

test("任意玩家按相同时间轴自动推导下一首，不需要 GM 在自然切歌时广播", () => {
  const s = plan();
  assert.equal(projectPlayback(s, 112_350).trackId, "a");
  assert.equal(projectPlayback(s, 112_400).trackId, "b");
  assert.ok(Math.abs(projectPlayback(s, 112_900).position - 0.5) < 1e-6);
  assert.equal(projectPlayback(s, 119_400).trackId, "c");
  assert.equal(projectPlayback(s, 143_000).trackId, "a");
  // JS 被系统挂起 6 个小时，恢复时仍可 O(曲目数) 找到正确歌曲。
  assert.equal(projectPlayback(s, 100_000 + 43_000 * 1000).trackId, "a");
  assert.equal(s.playback.trackId, "a", "原始 GM 指令时间锚点不能被预测修改");
  assert.equal(projectPlayback(s, 119_400).seq, 9);
});

test("单曲循环的时长取模、防止末尾停顿；默认不循环则停止", () => {
  const one = plan("track");
  assert.ok(Math.abs(projectPlayback(one, 125_300).position - 0.5) < 1e-6);
  assert.equal(projectPlayback(one, 125_300).trackId, "a");
  const off = plan("off");
  const last = projectPlayback(off, 160_000);
  assert.equal(last.trackId, "c");
  assert.equal(last.playing, false);
  assert.equal(last.position, 23.6);
});

test("晚加入设备从历史时间轴计算当前曲目与下一首预加载期限", () => {
  const s = plan();
  assert.equal(upcomingTrack(s, 111_800).track.id, "b");
  assert.ok(Math.abs(upcomingTrack(s, 111_800).inSeconds - 0.6) < 1e-6);
  assert.equal(upcomingTrack(s, 119_000).track.id, "c");
  assert.equal(upcomingTrack(plan("track"), 115_000).track.id, "a");
});

test("未知时长或未知循环模式不得假预测，必须使用GM结束事件兜底", () => {
  const s = plan();
  s.playlist[2].duration = 0;
  assert.equal(canPredictPlayback(s), false);
  assert.equal(projectPlayback(s, 180_000).trackId, "a");
  const single = plan("track");
  single.playlist[2].duration = 0;
  assert.equal(canPredictPlayback(single), true, "单曲循环只依赖自身时长");
  assert.equal(canPredictPlayback(plan("unknown")), false);
});
