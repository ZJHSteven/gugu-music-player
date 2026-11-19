import test from "node:test";
import assert from "node:assert/strict";
import { IosSyncAudio, expectedRoomPhase, phaseError } from
  "../../public/cloud/ios-sync-audio.js";

class FakeAudio {
  constructor() {
    this.controls = true;
    this.paused = true;
    this.currentTime = 0;
    this.duration = 12.4;
    this.readyState = 1;
    this.error = null;
    this.volume = 1;
    this.playbackRate = 1;
    this.listeners = {};
    this.playCount = 0;
    this.onPlay = null;
  }
  addEventListener(name, fn) {
    this.listeners[name] ||= [];
    this.listeners[name].push(fn);
  }
  load() { /* 模拟源复位后仍已读取 metadata */ }
  removeAttribute(name) { if (name === "src") this.src = ""; }
  play() {
    this.playCount++;
    this.onPlay?.();
    this.paused = false;
    return Promise.resolve();
  }
  pause() { this.paused = true; }
}

const track = { hash: "f".repeat(64), duration: 12.4, mime: "audio/mpeg" };
const state = (at = 100_000) => ({
  track, playback: {
    trackId: "song-a", anchor: 100_000, position: 0,
    playing: true, loop: "track", volume: 0.8,
  },
  serverTime: at,
});

const sleepTick = () => new Promise((resolve) => setImmediate(resolve));

function make(nowAt = 105_000, overrides = {}) {
  let room = state(nowAt);
  let time = nowAt;
  const audio = new FakeAudio();
  const states = [];
  const handoffs = [];
  const player = new IosSyncAudio({
    getNow: () => room,
    getVolume: () => 0.5,
    onStatus: (s) => states.push(s),
    onActive: (on) => handoffs.push(on),
    getFile: async () => new Blob(["ID3-audio"]),
    prepareSource: async () => ({
      blob: new Blob(["ID3-audio"], { type: "audio/mpeg" }),
      mime: "audio/mpeg",
    }),
    createAudio: () => audio,
    createUrl: () => "blob:fake-audio",
    revokeUrl: () => {},
    nowMs: () => time,
    ...overrides,
  });
  return {
    audio, player, states, handoffs,
    setTime: (v) => { time = v; },
    setRoom: (v) => { room = v; },
  };
}

test("单曲循环的目标相位来自统一GM时间轴，而不是本地循环次数", () => {
  assert.equal(expectedRoomPhase(state(), 100_000), 0);
  assert.ok(Math.abs(expectedRoomPhase(state(), 125_300) - 0.5) < 1e-8);
  assert.ok(Math.abs(phaseError(0.04, 12.39, 12.4, true) - 0.05) < 1e-8);
  assert.ok(Math.abs(phaseError(12.35, 0.05, 12.4, true) + 0.10) < 1e-8);
});

test("用户点击在同一调用栈同步执行Audio.play，播放器没有可拖动进度条", async () => {
  const { audio, player, handoffs } = make();
  assert.equal(audio.controls, false);
  await player.prepare();
  assert.equal(player.ready, true);
  assert.equal(handoffs.length, 0, "只是文件准备好不能令后台错误停播");
  let calledSynchronously = false;
  audio.onPlay = () => { calledSynchronously = true; };
  assert.equal(player.enableFromUserGesture(), true);
  assert.equal(calledSynchronously, true,
    "audio.play 必须在同步点击回调内部，而非Promise/消息广播之后");
  assert.equal(audio.controls, false);
  assert.ok(Math.abs(audio.currentTime - 5) < .05);
  await sleepTick();
  assert.deepEqual(handoffs, [true]);
  assert.equal(audio.volume, 0.4, "本地音量乘GM全局音量，不擅自修改房间设置");
  player.close();
  assert.deepEqual(handoffs, [true, false]);
});

test("未下载完不允许播放，也不会为了初始化媒体而抢占背景引擎", async () => {
  const { audio, player, handoffs } = make(105_000, { getFile: async () => null });
  await player.prepare();
  assert.equal(player.ready, false);
  assert.equal(player.enableFromUserGesture(), false);
  assert.equal(audio.playCount, 0);
  assert.deepEqual(handoffs, []);
  player.close();
});

test("Safari拒绝播放时不关闭后台，GM暂停后播放器自动暂停", async () => {
  const { audio, player, handoffs, setRoom } = make();
  audio.play = () => Promise.reject(Object.assign(
    new Error("User gesture not recognized"), { name: "NotAllowedError" }));
  await player.prepare();
  player.enableFromUserGesture();
  await sleepTick();
  assert.equal(player.active, false);
  assert.equal(player.error, "NotAllowedError");
  assert.deepEqual(handoffs, [], "失败时后台音频仍保留");

  audio.play = FakeAudio.prototype.play.bind(audio);
  player.enableFromUserGesture();
  await sleepTick();
  setRoom({ ...state(), playback: { ...state().playback, playing: false } });
  player.tick();
  assert.equal(audio.paused, true);
  assert.deepEqual(handoffs, [true]);
  player.close();
});

test("中等偏差温和闭环恢复，禁止玩家在本地手动改动GM进度", async () => {
  const { audio, player, setTime } = make();
  await player.prepare();
  player.enableFromUserGesture();
  await sleepTick();
  audio.currentTime = 5.3;
  player.tick();
  assert.ok(audio.playbackRate < 1 && audio.playbackRate >= 0.985);
  assert.equal(audio.controls, false);
  setTime(105_000 + 3_000);
  player.tick();
  // 只有GM时间轴推进，页面才会计算出新的目标播放位置。
  assert.equal(expectedRoomPhase(state(), 108_000), 8);
  player.close();
});
