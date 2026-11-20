/**
 * “已转发全部字节”不等于“SHA-256 正确并保存成功”。
 * 这个回归用一帧长度完全正确但摘要错误的音频验证诊断能定位完整收包后的错误。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { RelayClient } from "../../public/cloud/relay-client.js";
import { encodeChunk } from "../../public/cloud/wire.js";

test("长度完整而 SHA-256 不一致时报告 integrity/hash-mismatch", async () => {
  const oldWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class WebSocketMock { static OPEN = 1; };
  const observed = [];
  const client = new RelayClient("test-room", "test-secret", () => {},
    (err) => observed.push(err));
  client.ws = { readyState: 1, send() {}, close() {} };
  try {
    const hash = "f".repeat(64);
    const bytes = new Uint8Array([82, 73, 70, 70, 10, 11, 12]);
    client.tracks = [{ hash, size: bytes.length, mime: "audio/wav" }];
    client.requested.add(hash);
    await client.onChunk(encodeChunk({
      hash, from: "11111111-1111-1111-1111-111111111111",
      to: "22222222-2222-2222-2222-222222222222",
      index: 0, total: 1,
    }, bytes));
    assert.equal(observed.length, 1);
    assert.equal(client.metrics.receivedBytes, bytes.length);
    assert.equal(client.metrics.verified, 0);
    assert.equal(client.diagnostics().files[0].receivedChunks, 0);
    const failure = client.events.find((event) => event.type === "failure");
    assert.equal(failure.phase, "integrity");
    assert.equal(failure.reason, "hash-mismatch");
  } finally {
    client.close();
    if (oldWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = oldWebSocket;
  }
});
