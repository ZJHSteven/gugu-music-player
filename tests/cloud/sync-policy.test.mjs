import test from "node:test";
import assert from "node:assert/strict";
import { shouldSnapOnCloudUpdate, initialCloudSeek } from "../../public/cloud/sync-policy.js";

const playback = { trackId: "song", playing: true, seq: 5 };
test("云端房间设置、广播重复事件不会引起音频位置跳跃", () => {
  assert.equal(shouldSnapOnCloudUpdate(playback, { ...playback }, 2, 2.01), false);
  assert.equal(shouldSnapOnCloudUpdate(playback, { ...playback, seq: 6 }, 4.2, 4.22), false);
  assert.equal(shouldSnapOnCloudUpdate(playback, { ...playback, seq: 6 }, 4.2, 4.8), false);
  assert.equal(shouldSnapOnCloudUpdate(playback, { ...playback, seq: 6 }, 12.4, 0.2), true);
});

test("暂停/恢复、切歌显式改变时间轴时只需重新定位一次", () => {
  assert.equal(shouldSnapOnCloudUpdate(playback, { ...playback, seq: 6, playing: false }, 5, 5), true);
  assert.equal(shouldSnapOnCloudUpdate(playback, { ...playback, seq: 6, trackId: "another" }, 5, 0), true);
  assert.equal(shouldSnapOnCloudUpdate(playback, { ...playback, seq: 6 }, 9, 1), true);
});

test("短单曲循环晚加入不会把 currentTime 设在曲长之外", () => {
  assert.ok(Math.abs(initialCloudSeek(26.3, 12.4, "track", true) - 1.5) < 0.0001);
  assert.equal(initialCloudSeek(26.3, 12.4, "list", true), 12.4);
  assert.equal(initialCloudSeek(-2, 12.4, "track", false), 0);
  assert.equal(initialCloudSeek(4.2, 12.4, "track", true), 4.2);
});
