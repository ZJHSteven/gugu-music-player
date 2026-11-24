import test from "node:test";
import assert from "node:assert/strict";
import { prioritizeTracks } from "../../public/cloud/request-priority.js";

test("迟到玩家先下载当前、接下来要播放的曲目，历史歌曲最后补齐", () => {
  const tracks = [{ id: "intro" }, { id: "battle" }, { id: "boss" }, { id: "end" }];
  assert.deepEqual(prioritizeTracks(tracks, "boss").map((t) => t.id),
    ["boss", "end", "intro", "battle"]);
  assert.deepEqual(tracks.map((t) => t.id), ["intro", "battle", "boss", "end"]);
  assert.deepEqual(prioritizeTracks(tracks, "not-found"), tracks);
  assert.deepEqual(prioritizeTracks([], "boss"), []);
});
