import test from "node:test";
import assert from "node:assert/strict";
import { IosSyncAudio, silentUnlockWav, expectedRoomPhase, phaseError } from
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

test("歌曲尚未下载完成也可先开启Safari声音：一次用户点击启动静音授权，不抢后台", async () => {
  const { audio, player, handoffs } = make(105_000, { getFile: async () => null });
  await player.prepare();
  assert.equal(player.ready, false);
  assert.equal(player.enableFromUserGesture(), true);
  assert.equal(audio.playCount, 1, "不能等下载完成之后才调用用户手势里的play()");
  await sleepTick();
  assert.equal(player.armed, true);
  assert.equal(player.authorized, true);
  assert.equal(audio.controls, false, "绝不能暴露原生进度条给普通玩家");
  assert.deepEqual(handoffs, []);
  player.close();
});

test("静音授权WAV是有效的零样本PCM文件，而非无法解码的空Blob", async () => {
  const blob = silentUnlockWav();
  const arr = new Uint8Array(await blob.arrayBuffer());
  assert.equal(blob.type, "audio/wav");
  assert.equal(String.fromCharCode(...arr.slice(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...arr.slice(8, 12)), "WAVE");
  assert.equal(arr.length, 4044);
  assert.ok(arr.slice(44).every((x) => x === 0));
});

test("另一iframe延迟传完音频后，无需第二次点击即可自动按GM时间表接续", async () => {
  let fileAvailable = false;
  let getCount = 0;
  const { audio, player, handoffs } = make(105_000, {
    getFile: async () => {
      getCount++;
      return fileAvailable ? new Blob(["ID3-complete-audio"]) : null;
    },
  });
  await player.prepare();
  player.enableFromUserGesture();
  await sleepTick();
  assert.equal(audio.playCount, 1);
  assert.equal(player.armed, true);
  assert.deepEqual(handoffs, [], "静音预授权还不是真实歌曲出声");
  fileAvailable = true;
  await player.prepare(state(), { force: true }); // 模拟同源iframe校验完成通知
  await sleepTick();
  assert.equal(getCount, 2);
  assert.equal(player.ready, true);
  assert.equal(player.active, true);
  assert.equal(audio.playCount, 2, "必须复用刚收到手势的同一个Audio");
  assert.ok(Math.abs(audio.currentTime - 5) < 0.05);
  assert.deepEqual(handoffs, [true]);
  player.close();
});

test("音频下载与静音play()的Promise并发，不能提前切源取消首次授权", async () => {
  let complete;
  const input = new Promise((resolve) => { complete = resolve; });
  let finishPlay;
  const playResult = new Promise((resolve) => { finishPlay = resolve; });
  const { audio, player, handoffs } = make(105_000, { getFile: () => input });
  audio.play = function () {
    this.playCount++;
    this.paused = false;
    return this.playCount === 1 ? playResult : Promise.resolve();
  };
  const loading = player.prepare();
  assert.equal(player.enableFromUserGesture(), true);
  complete(new Blob(["ID3-music"]));
  await loading;
  assert.equal(player.ready, false, "首个play()未获准前只能暂存真正的音乐Blob");
  assert.ok(player.pendingSource);
  finishPlay();
  await sleepTick();
  assert.equal(player.ready, true);
  assert.equal(player.active, true);
  assert.deepEqual(handoffs, [true]);
  player.close();
});

test("同一12秒循环的重复now广播不会销毁Audio或重复播放", async () => {
  const { audio, player } = make();
  await player.prepare();
  player.enableFromUserGesture();
  await sleepTick();
  const firstSrc = audio.src;
  const count = audio.playCount;
  for (let i = 0; i < 25; i++) await player.prepare(state(105_000 + i * 500));
  assert.equal(audio.playCount, count);
  assert.equal(audio.src, firstSrc);
  assert.equal(player.active, true);
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

test("GM 显式 seek 修改 seq 后立即按新锚点跳转，不误等待长期漂移冷却", async () => {
  const { audio, player, setRoom } = make(105_000);
  await player.prepare();
  player.enableFromUserGesture();
  await sleepTick();
  const moved = state();
  moved.playback.seq = 22;
  moved.playback.position = 9.4;
  moved.playback.anchor = 105_000;
  setRoom(moved);
  player.applyRoomState(moved);
  assert.ok(Math.abs(audio.currentTime - 9.4) < 0.001);
  player.close();
});

test("GM时间表自然跨入下一曲，即使不广播、后台iframe不活跃，iOS也切源", async () => {
  const { player, audio, setRoom } = make(105_000);
  await player.prepare();
  player.enableFromUserGesture();
  await sleepTick();
  const second = state();
  second.track = { hash: "b".repeat(64), duration: 7.5, mime: "audio/mpeg" };
  second.playback = {
    ...second.playback, trackId: "song-b", anchor: 105_000, position: 0.5,
  };
  // 不调用任何 CloudBridge.subscribe，只有本地 tick 对比绝对计划。
  setRoom(second);
  player.tick();
  await sleepTick();
  assert.equal(player.trackHash, second.track.hash);
  assert.equal(player.ready, true);
  assert.equal(audio.controls, false);
  assert.ok(audio.playCount >= 2, "获授权的同一个Audio元素继续接下一首");
  player.close();
});
