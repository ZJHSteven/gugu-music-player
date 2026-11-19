/**
 * 真实 Cloudflare Durable Object 状态快照端到端测试（只测试随机房间）。
 * 测试不接触任何 Owlbear 真实房间；生产发布之前可用本地 wrangler 验证。
 *
 *   $env:GUGU_ORIGIN='http://127.0.0.1:8797'
 *   node tests/cloud/room-snapshot-smoke.mjs
 *
 * 覆盖内容地址不可变写入、读取、相同摘要去重、错误摘要拒绝、非法/超大输入。
 * 房间状态只是歌单 JSON，不把音频内容写入 DO 持久存储。
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";

const origin = process.env.GUGU_ORIGIN || "http://127.0.0.1:8797";
const room = `snapshot-e2e-${randomUUID().slice(0, 12)}`;
const secret = randomBytes(16).toString("hex");
const state = {
  v: 1, rev: 27, secret,
  playlist: Array.from({ length: 20 }, (_, i) => ({
    id: `song-${i}`, title: `Track ${i}`,
    hash: randomBytes(32).toString("hex"), duration: 12.4 + i, size: 600_000,
    mime: "audio/mpeg", folder: "探索",
  })),
  playback: { trackId: "song-7", playing: true, position: 4.2,
    anchor: Date.now(), loop: "list", seq: 11, volume: .8 },
  folders: ["探索", "战斗"],
  settings: { hideTitle: false },
};
const data = JSON.stringify(state);
const hash = createHash("sha256").update(data).digest("hex");
const endpoint = `${origin}/room-state?${new URLSearchParams({
  room, key: secret, hash,
})}`;
const post = (url, body) => fetch(url, {
  method: "POST", headers: { "Content-Type": "application/json" }, body,
});

const first = await post(endpoint, data);
assert.equal(first.status, 204);
const second = await post(endpoint, data);
assert.equal(second.status, 204, "相同内容不可变去重写入");
const fetchResult = await fetch(endpoint);
assert.equal(fetchResult.status, 200);
assert.deepEqual(await fetchResult.json(), state);

const incorrect = `${origin}/room-state?${new URLSearchParams({
  room, key: secret, hash: "0".repeat(64),
})}`;
assert.equal((await post(incorrect, data)).status, 422, "篡改摘要不得写入");
assert.equal((await fetch(incorrect)).status, 404, "未知摘要必须返回404");
assert.equal((await fetch(`${origin}/room-state?room=${room}&key=${secret}&hash=xyz`)).status,
  400, "摘要格式错误必须返回400");

const huge = JSON.stringify({ contents: "X".repeat(65 * 1024) });
const hugeHash = createHash("sha256").update(huge).digest("hex");
const hugeEndpoint = `${origin}/room-state?${new URLSearchParams({
  room, key: secret, hash: hugeHash,
})}`;
assert.equal((await post(hugeEndpoint, huge)).status, 413,
  "DO严禁无限增长的大型JSON，更不能直接代替R2存音频");

console.log(`✓ 真实DO快照：歌单${state.playlist.length}首，${data.length}字节，\n` +
  "  POST/GET及SHA256、重复写入、坏摘要、超过64KB均按预期验收");
