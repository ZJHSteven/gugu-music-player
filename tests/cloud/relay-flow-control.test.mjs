/**
 * 音频逐块背压的回归测试，不需要真实用户的房间或音频。
 * 包括 ACK 丢失、数据丢失、发送端断线，以及接收端已存/重复帧。
 * 无确认旧协议由 audio-sender.test.mjs 继续独立覆盖。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { sendAudioWithAck } from "../../public/cloud/audio-sender.js";
import { RelayClient } from "../../public/cloud/relay-client.js";
import { CHUNK_SIZE, decodeChunk, encodeChunk } from "../../public/cloud/wire.js";

const from = "11111111-1111-1111-1111-111111111111";
const to = "22222222-2222-2222-2222-222222222222";
const hash = "a".repeat(64);

test("9块音频只有上一块被确认后才发送下一块：丢一个数据块及一个ACK能恢复", async () => {
  const source = new Uint8Array(CHUNK_SIZE * 8 + 21);
  for (let i = 0; i < source.length; i++) source[i] = i % 251;
  const saved = new Array(9);
  const sends = [];
  const acknowledged = new Set();
  const ws = {
    readyState: 1,
    send(frame) {
      const { header, bytes } = decodeChunk(frame);
      sends.push(header.index);
      // 模拟分块1第一次没到浏览器；分块4第一次到达但ACK丢失。
      const attempts = sends.filter((i) => i === header.index).length;
      if (header.index === 1 && attempts === 1) return;
      saved[header.index] ??= Uint8Array.from(bytes);
      if (header.index !== 4 || attempts > 1) acknowledged.add(header.index);
    },
  };
  const result = await sendAudioWithAck({
    ws, file: new Blob([source]), hash, from, to,
    ackTimeoutMs: 5, maxAttempts: 3,
    waitForAck: (index, timeoutMs) => acknowledged.has(index)
      ? Promise.resolve()
      : new Promise((_, reject) => setTimeout(() => reject(new Error("lost ack")), timeoutMs)),
  });
  assert.equal(result, true);
  assert.deepEqual(sends, [0, 1, 1, 2, 3, 4, 4, 5, 6, 7, 8]);
  assert.deepEqual(Buffer.concat(saved.map(Buffer.from)), Buffer.from(source));
});

test("一直没有ACK时必须在有限重试次数后失败，不得继续轰炸DO", async () => {
  let sent = 0;
  const ws = { readyState: 1, send() { sent++; } };
  await assert.rejects(() => sendAudioWithAck({
    ws, file: new Blob([new Uint8Array(CHUNK_SIZE * 3)]), hash, from, to,
    ackTimeoutMs: 1, maxAttempts: 3,
    waitForAck: () => Promise.reject(new Error("missing")),
  }), /1\/3.*超时/);
  assert.equal(sent, 3, "只允许重试第一块，不能进入后续两个块");
});

test("发送途中关闭WebSocket不能虚报完整发送", async () => {
  const ws = { readyState: 1, send() { this.readyState = 3; } };
  const ok = await sendAudioWithAck({
    ws, file: new Blob([new Uint8Array(CHUNK_SIZE * 2)]), hash, from, to,
    ackTimeoutMs: 1, maxAttempts: 2, waitForAck: () => Promise.reject(new Error("closed")),
  });
  assert.equal(ok, false);
});

test("接收端重复帧和已有文件仍必须逐块ACK，避免发送端死锁", async () => {
  const oldWs = globalThis.WebSocket;
  globalThis.WebSocket = class { static OPEN = 1; };
  const messages = [];
  const client = new RelayClient("test-room", "test-secret");
  client.ws = { readyState: 1, send(msg) { messages.push(JSON.parse(msg)); }, close() {} };
  const bytes = new Uint8Array(CHUNK_SIZE);
  const frame = encodeChunk({ from, to, hash, index: 0, total: 2 }, bytes);
  client.tracks = [{ hash, size: CHUNK_SIZE * 2, mime: "audio/wav" }];
  try {
    await client.onChunk(frame);
    await client.onChunk(frame);
    assert.equal(client.metrics.receivedBytes, CHUNK_SIZE, "重复块不能重复计入有效字节");
    assert.equal(client.metrics.receivedFrames, 1);
    assert.equal(messages.filter((m) => m.t === "ack").length, 2);
    client.owned.add(hash);
    await client.onChunk(frame);
    assert.equal(messages.filter((m) => m.t === "ack").length, 3);
  } finally {
    client.close();
    if (oldWs === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = oldWs;
  }
});

test("新版请求显式携带ack-v1，旧版源可忽略该字段", () => {
  const oldWs = globalThis.WebSocket;
  globalThis.WebSocket = class { static OPEN = 1; };
  const messages = [];
  const client = new RelayClient("test-room", "test-secret");
  client.ws = { readyState: 1, send(msg) { messages.push(JSON.parse(msg)); }, close() {} };
  try {
    client.tracks = [{ hash, size: 120, mime: "audio/wav" }];
    client.request(hash);
    assert.deepEqual(messages[0], { t: "need", hash, flowControl: "ack-v1" });
  } finally {
    client.close();
    if (oldWs === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = oldWs;
  }
});
