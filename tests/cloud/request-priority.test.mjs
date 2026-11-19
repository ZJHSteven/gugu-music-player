import test from "node:test";
import assert from "node:assert/strict";
import { prioritizeTracks } from "../../public/cloud/request-priority.js";

test("迟到玩家首先下载当前播放的曲目，剩余歌曲仍保持歌单顺序", () => {
  const tracks = [{ id: "intro" }, { id: "battle" }, { id: "boss" }, { id: "end" }];
  assert.deepEqual(prioritizeTracks(tracks, "boss").map((t) => t.id),
    ["boss", "intro", "battle", "end"]);
  assert.deepEqual(tracks.map((t) => t.id), ["intro", "battle", "boss", "end"]);
  assert.deepEqual(prioritizeTracks(tracks, "not-found"), tracks);
  assert.deepEqual(prioritizeTracks([], "boss"), []);
});
