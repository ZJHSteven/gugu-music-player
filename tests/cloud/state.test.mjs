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
  assert.equal(publicNow(state).track.src, `cloud:${HASH_A}`);
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
  s = applyCommand(s, { type: "ended" });
  assert.equal(s.playback.playing, false);
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
  s = applyCommand(s, { type: "select", trackId: s.playlist[0].id });
  const initialSeq = s.playback.seq;
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

test("歌单超过 Owlbear Metadata 安全阈值时明确拒绝", () => {
  let s = createState(secret);
  assert.throws(() => {
    for (let i = 0; i < 300; i++) s = addTrack(s, {
      title: "一首很长的歌曲标题".repeat(5), hash: HASH_A, size: 1000,
    });
  }, /16 KB 上限/);
});
