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
