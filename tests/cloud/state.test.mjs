/**
 * 云端状态机测试：无网络、无真实 Owlbear 房间。
 * 验证上一首、下一首、循环、拖动、目录、隐私、容量上限与权限适配用的纯数据。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  createState, applyCommand, addTrack, publicNow, publicState,
  currentPosition, normalizeState, assertMetadataSize,
} from "../../public/cloud/state.js";
import { projectPlayback } from "../../public/cloud/plan.js";

globalThis.crypto ??= webcrypto;
const secret = "0123456789abcdef0123456789abcdef";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function twoTracks() {
  let state = createState(secret);
  state = addTrack(state, { title: "战斗音乐", hash: HASH_A, size: 1000, duration: 60, folder: "战斗" });
  return addTrack(state, { title: "探索音乐", hash: HASH_B, size: 2000, duration: 90, folder: "探索" });
}

test("初始化、Owlbear 房间状态与曲目摘要正确", () => {
  const state = twoTracks();
  assert.equal(state.playlist.length, 2);
  assert.equal(state.playlist[0].hash, HASH_A);
  assert.equal(state.playlist[1].folder, "探索");
  assert.equal(publicState(state).playlist[0].src, `cloud:${HASH_A}`);
  assert.deepEqual(normalizeState(state)?.playlist, state.playlist);
  assert.equal(normalizeState({ secret: "bad", v: 1, playlist: [] }), null);
  assert.ok(assertMetadataSize(state) < 14 * 1024);
});

test("播放状态只使用锚点推算，无逐秒服务端消息", () => {
  let state = twoTracks();
  const t = 1730000000000;
  state = applyCommand(state, { type: "play" }, t);
  assert.equal(state.playback.trackId, state.playlist[0].id);
  assert.equal(currentPosition(state.playback, t + 5000), 5);
  state = applyCommand(state, { type: "pause" }, t + 5000);
  assert.equal(currentPosition(state.playback, t + 10000), 5);
  state = applyCommand(state, { type: "seek", position: 26 }, t + 12000);
  assert.equal(state.playback.position, 26);
  state = applyCommand(state, { type: "play" }, t + 13000);
  assert.equal(currentPosition(state.playback, t + 15000), 28);
  // 不可再使用当前真实年份的 Date.now() 来查询测试里设定的历史 2024
  // 时间锚点；新协议会在真实过去两年的时间轴上自动推进数百万首歌曲。
  assert.equal(publicNow(state, t + 15000).track.src, `cloud:${HASH_A}`);
});

test("曲目进退、单曲循环、末尾停止和歌单增删", () => {
  let s = twoTracks();
  s = applyCommand(s, { type: "select", trackId: s.playlist[0].id });
  s = applyCommand(s, { type: "next" });
  assert.equal(s.playback.trackId, s.playlist[1].id);
  s = applyCommand(s, { type: "settings", loop: "track", volume: 0.4 });
  s = applyCommand(s, { type: "ended" });
  assert.equal(s.playback.trackId, s.playlist[1].id);
  s = applyCommand(s, { type: "settings", loop: "off" });
  // 已知时长的 off 模式应靠统一计划自行停止，不依赖任何 GM ended 广播。
  const atEnd = projectPlayback(s, s.playback.anchor +
    (s.playlist[1].duration + 1) * 1000);
  assert.equal(atEnd.playing, false);
  s = applyCommand(s, { type: "playlist", op: "remove", trackId: s.playlist[1].id });
  assert.equal(s.playlist.length, 1);
  s = applyCommand(s, { type: "playlist", op: "clear" });
  assert.equal(s.playback.trackId, null);
});

test("修改设置不应导致歌曲进度跳回起点", () => {
  let state = twoTracks();
  const t = 1730000000000;
  state = applyCommand(state, { type: "play" }, t);
  state = applyCommand(state, { type: "settings", volume: 0.5 }, t + 25000);
  assert.equal(state.playback.position, 25);
  assert.equal(state.playback.volume, 0.5);
});

test("自动结束携带播放序列号：延迟或重复的 ended 绝不跳过新歌", () => {
  let s = twoTracks();
  // 已知时长使用预测式切歌，旧 GM 端的 ended 包必须被忽略；
  // 但曲目缺失时长时仍支持旧式 ended + expectedSeq 兜底。
  s = applyCommand(s, { type: "select", trackId: s.playlist[0].id });
  const initialSeq = s.playback.seq;
  assert.equal(applyCommand(s, { type: "ended", expectedSeq: initialSeq }), s);
  // 某一首时长不可预测，客户端不应继续自行推演顺序。
  s.playlist[1].duration = 0;
  s = applyCommand(s, { type: "ended", expectedSeq: initialSeq });
  assert.equal(s.playback.trackId, s.playlist[1].id);
  assert.equal(s.playback.playing, true);
  const afterFirst = s.rev;
  const nextSeq = s.playback.seq;
  // 同一首旧歌的后续结束通知到达时，当前播放状态不能改变。
  s = applyCommand(s, { type: "ended", expectedSeq: initialSeq });
  assert.equal(s.rev, afterFirst);
  assert.equal(s.playback.seq, nextSeq);
  assert.equal(s.playback.trackId, s.playlist[1].id);
  // 手工暂停后再来的 ended 即使序列匹配也不能重新开始。
  s = applyCommand(s, { type: "pause" });
  const pausedRev = s.rev;
  s = applyCommand(s, { type: "ended", expectedSeq: s.playback.seq });
  assert.equal(s.rev, pausedRev);
  assert.equal(s.playback.playing, false);
});

test("短歌循环即使后台定时器延迟，也保留当前相位而不把音乐跳回零秒", () => {
  const s0 = twoTracks();
  const duration = 12.4;
  const first = s0.playlist[0];
  first.duration = duration;
  let s = applyCommand(s0, { type: "settings", loop: "track" }, 100_000);
  s = applyCommand(s, { type: "select", trackId: first.id }, 100_000);
  // 正常情况下下一轮刚开始 0.1s 才收到消息。
  const firstSeq = s.playback.seq;
  const naturallyLooped = projectPlayback(s, 112_500);
  assert.ok(Math.abs(naturallyLooped.position - 0.1) < 0.00001);
  // 不管旧 GM 发来几次重复 ended，原始房间计划仍保持不变。
  assert.equal(applyCommand(s, { type: "ended", expectedSeq: firstSeq },
    112_500), s);
  // JS 被系统暂停 38s 才恢复时，应恢复到第 4 轮已经走过的 0.8s，
  // 而不是跳回开头并与其余浏览器产生突兀的不同步。
  const nextNow = 112_500 + 38_000;
  const predicted = (38_000 / 1000 + 0.1) % duration;
  assert.ok(Math.abs(projectPlayback(s, nextNow).position - predicted) < 0.00001);
});

test("隐私设置、分类管理及非法操作", () => {
  let s = twoTracks();
  s = applyCommand(s, { type: "settings", hideTitle: true });
  s = applyCommand(s, { type: "play" });
  assert.equal(publicNow(s).track.title, null);
  s = applyCommand(s, { type: "folder", op: "create", name: "悬疑" });
  s = applyCommand(s, { type: "track.folder", trackId: s.playlist[0].id, folder: "悬疑" });
  assert.equal(s.playlist[0].folder, "悬疑");
  s = applyCommand(s, { type: "folder", op: "rename", name: "悬疑", newName: "地下城" });
  assert.equal(s.playlist[0].folder, "地下城");
  assert.throws(() => applyCommand(s, { type: "playlist", op: "move", from: 0, to: 999 }), /越界/);
  assert.throws(() => applyCommand(s, { type: "select", trackId: "missing" }), /曲目不存在/);
});

test("原生Metadata使用14KiB限制，容量不足后DO快照允许增长到60KiB", () => {
  let s = createState(secret);
  assert.ok(assertMetadataSize(s) < 14 * 1024);
  for (let i = 0; i < 120; i++) {
    s = addTrack(s, { title: "歌单条目", hash: HASH_A, size: 1000 });
  }
  assert.equal(s.playlist.length, 120, "较大的歌单不应在14KiB被状态机提前拒绝");
  assert.throws(() => assertMetadataSize(s), /16 KB 上限/);
  // 大型歌单最终仍必须尊重不可变快照的60KiB硬上限。
  assert.throws(() => {
    for (let i = 0; i < 300; i++) s = addTrack(s, {
      title: "一首很长的歌曲标题".repeat(5), hash: HASH_A, size: 1000,
    });
  }, /60 KiB 上限/);
});
