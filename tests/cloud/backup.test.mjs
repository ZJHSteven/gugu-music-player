import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createBackupArchive, readBackupArchive } from "../../public/cloud/backup.js";

test("ZIP 本地备份包含可独立恢复的原始音频、曲名、时长和分类", async () => {
  const bytes = Buffer.from(Array.from({ length: 127013 }, (_, i) => i % 251));
  const hash = createHash("sha256").update(bytes).digest("hex");
  const track = {
    hash, title: "12 秒循环歌曲", size: bytes.byteLength, duration: 12.40322,
    mime: "audio/wav", folder: "战斗",
  };
  const archive = await createBackupArchive(
    [track], new Map([[hash, new Blob([bytes], { type: track.mime })]]));
  assert.ok(archive.size > bytes.byteLength);
  const data = await readBackupArchive(archive);
  assert.equal(data.tracks[0].title, track.title);
  assert.equal(data.tracks[0].duration, track.duration);
  assert.equal(data.tracks[0].folder, track.folder);
  assert.deepEqual(Buffer.from(await data.files.get(`audio/${hash}`).arrayBuffer()), bytes);
});

test("备份不完整和 ZIP 内容损坏必须拒绝恢复", async () => {
  const hash = "a".repeat(64);
  await assert.rejects(createBackupArchive(
    [{ hash, title: "缺失文件", size: 100, duration: 10 }], new Map()), /不可用/);
  await assert.rejects(readBackupArchive(new Blob(["not a valid zip"])), /损坏/);
  const bytes = Buffer.from("hello world");
  const realHash = createHash("sha256").update(bytes).digest("hex");
  const zip = await createBackupArchive(
    [{ hash: realHash, title: "demo", size: bytes.length, duration: 2 }],
    new Map([[realHash, new Blob([bytes])]]));
  const damaged = new Uint8Array(await zip.arrayBuffer());
  const localHeaderBytes = 30 + "manifest.json".length;
  damaged[localHeaderBytes + 4] ^= 0x20;
  await assert.rejects(readBackupArchive(new Blob([damaged])), /校验失败/);
});

test("ZIP 缺少某首原文件时：严格模式拒绝，GM 部分恢复模式列出缺失曲目", async () => {
  const a = Buffer.from("valid-track-a");
  const b = Buffer.from("valid-track-b");
  const ha = createHash("sha256").update(a).digest("hex");
  const hb = createHash("sha256").update(b).digest("hex");
  const zip = await createBackupArchive([
    { title: "仍可恢复", hash: ha, size: a.length, duration: 1 },
    { title: "ZIP 文件中缺失", hash: hb, size: b.length, duration: 1 },
  ], new Map([[ha, new Blob([a])], [hb, new Blob([b])]]));
  const original = new Uint8Array(await zip.arrayBuffer());
  const view = new DataView(original.buffer);
  let pos = 0, removeFrom = -1, removeTo = -1;
  while (pos + 30 < original.byteLength && view.getUint32(pos, true) === 0x04034b50) {
    const size = view.getUint32(pos + 18, true);
    const filenameLength = view.getUint16(pos + 26, true);
    const extraLength = view.getUint16(pos + 28, true);
    const name = new TextDecoder().decode(original.slice(pos + 30, pos + 30 + filenameLength));
    const end = pos + 30 + filenameLength + extraLength + size;
    if (name === `audio/${hb}`) { removeFrom = pos; removeTo = end; break; }
    pos = end;
  }
  assert.ok(removeFrom > 0 && removeTo > removeFrom);
  const partial = new Blob([original.slice(0, removeFrom), original.slice(removeTo)]);
  await assert.rejects(readBackupArchive(partial), /缺失/);
  const recovered = await readBackupArchive(partial, { allowPartial: true });
  assert.equal(recovered.tracks.length, 2);
  assert.deepEqual(recovered.missing, [{ title: "ZIP 文件中缺失", hash: hb }]);
  assert.deepEqual(Buffer.from(await recovered.files.get(`audio/${ha}`).arrayBuffer()), a);
  assert.equal(recovered.files.has(`audio/${hb}`), false);
});
