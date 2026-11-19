import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CHUNK_SIZE, decodeChunk } from "../../public/cloud/wire.js";
import { sendAudioWithoutAck } from "../../public/cloud/audio-sender.js";

test("跨过 2 MiB 边界，即便收不到应用层 ACK 仍完整发出整首歌", async () => {
  const bytes = new Uint8Array(CHUNK_SIZE * 9 + 17);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const hash = createHash("sha256").update(bytes).digest("hex");
  const from = "a".repeat(8) + "-" + "a".repeat(4) + "-" + "a".repeat(4) +
    "-" + "a".repeat(4) + "-" + "a".repeat(12);
  const to = from.replaceAll("a", "b");
  const frames = [];
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    // 不提供任何 ACK 回调：复现移动端完全没有确认回应的现场。
    send(data) { frames.push(data); },
  };
  const result = await sendAudioWithoutAck({
    ws, file: new Blob([bytes]), hash, from, to,
  });
  assert.equal(result, true);
  assert.equal(frames.length, 10, "两 MiB 之后的最后两块不能因缺 ACK 消失");
  const received = frames.map((frame, index) => {
    const { header, bytes: chunk } = decodeChunk(frame);
    assert.equal(header.index, index);
    assert.equal(header.total, 10);
    assert.equal(header.to, to);
    return Buffer.from(chunk);
  });
  assert.deepEqual(Buffer.concat(received), Buffer.from(bytes));
  assert.equal(createHash("sha256").update(Buffer.concat(received)).digest("hex"), hash);
});

test("传输中途 WebSocket 关闭不把半截文件报告成完整发送", async () => {
  const file = new Blob([new Uint8Array(CHUNK_SIZE * 10)]);
  let count = 0;
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    send() {
      count++;
      if (count === 5) this.readyState = 3;
    },
  };
  const done = await sendAudioWithoutAck({
    ws, file, hash: "a".repeat(64),
    from: "b".repeat(36), to: "c".repeat(36),
  });
  assert.equal(done, false);
  assert.equal(count, 5);
});
