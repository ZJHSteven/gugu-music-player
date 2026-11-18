/** 音频帧编码、长度和元数据边界测试。 */
import test from "node:test";
import assert from "node:assert/strict";
import { CHUNK_SIZE, encodeChunk, decodeChunk } from "../../public/cloud/wire.js";

const header = { hash: "a".repeat(64), to: "12345678-1234-1234-1234-123456789abc", index: 0, total: 2 };
test("二进制帧打包解包不改变任何字节", () => {
  const bytes = crypto.getRandomValues(new Uint8Array(1024));
  const wire = encodeChunk(header, bytes);
  const decoded = decodeChunk(wire);
  assert.deepEqual(decoded.header, header);
  assert.deepEqual(decoded.bytes, bytes);
});
test("最大 256 KiB 分块", () => {
  assert.equal(decodeChunk(encodeChunk(header, new Uint8Array(CHUNK_SIZE))).bytes.byteLength, CHUNK_SIZE);
  assert.throws(() => encodeChunk(header, new Uint8Array(CHUNK_SIZE + 1)), /长度不正确/);
});
test("非法 HASH、目标与序号被拒绝", () => {
  for (const patch of [
    { hash: "bad" }, { to: "other" }, { index: 2 }, { total: 0 }, { index: -1 },
  ]) assert.throws(() => decodeChunk(encodeChunk({ ...header, ...patch }, new Uint8Array([1]))));
  assert.throws(() => decodeChunk(new Uint8Array([0, 0, 255, 255, 5, 4]).buffer), /帧头/);
});
