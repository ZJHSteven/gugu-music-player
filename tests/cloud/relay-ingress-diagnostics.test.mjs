/**
 * 真实浏览器WebSocket message入口诊断的单元测试。
 * 核心防回归目标：音频包若已触发message，但随后被协议或状态机拒绝，
 * 匿名报告不能再错误地显示成「浏览器一个二进制包也没收到」。
 * 覆盖ArrayBuffer / Blob两种标准二进制承载方式以及非法帧。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { RelayClient } from "../../public/cloud/relay-client.js";
import { encodeChunk } from "../../public/cloud/wire.js";
import { makeDiagnosticReport } from "../../public/cloud/diagnostics.js";

const hash = "a".repeat(64);
const from = "11111111-1111-1111-1111-111111111111";
const to = "22222222-2222-2222-2222-222222222222";
const nextTick = () => new Promise((resolve) => setTimeout(resolve, 20));

test("ArrayBuffer已抵达浏览器，但块长度不匹配：原始计数不能被状态机静默吞掉", async () => {
  const original = globalThis.WebSocket;
  const oldLocation = globalThis.location;
  globalThis.location = { protocol: "https:", host: "example.test" };
  class WS { static OPEN = 1; readyState = 1; send() {} close() {} }
  globalThis.WebSocket = WS;
  const client = new RelayClient("test", "test");
  try {
    client.tracks = [{ hash, size: 10, mime: "audio/wav" }];
    client.connect();
    const frame = encodeChunk({ hash, from, to, index: 0, total: 1 }, new Uint8Array(9));
    client.ws.onmessage({ data: frame });
    await nextTick();
    const d = client.diagnostics();
    assert.equal(d.rawBinaryMessages, 1);
    assert.equal(d.rawBinaryBytes, frame.byteLength);
    assert.equal(d.parsedFrames, 1);
    assert.equal(d.rejectedFrames, 1);
    assert.equal(d.lastRejectReason, "chunk-size-mismatch");
    assert.equal(d.receivedBytes, 0);
    assert.equal(d.controlMessages, 0);
    const report = makeDiagnosticReport({ panelRelay: d });
    const json = JSON.parse(report.slice(report.indexOf("{")));
    assert.equal(json.relayInPanel.rawBinaryMessages, 1);
    assert.equal(json.relayInPanel.lastRejectReason, "chunk-size-mismatch");
    assert.ok(!JSON.stringify(json).includes("test-secret"));
  } finally {
    client.close();
    if (original === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = original;
    if (oldLocation === undefined) delete globalThis.location;
    else globalThis.location = oldLocation;
  }
});

test("浏览器将二进制事件交付为Blob时仍然能够解析；坏帧也明确计入拒绝", async () => {
  const original = globalThis.WebSocket;
  const oldLocation = globalThis.location;
  globalThis.location = { protocol: "https:", host: "example.test" };
  class WS { static OPEN = 1; readyState = 1; send() {} close() {} }
  globalThis.WebSocket = WS;
  const client = new RelayClient("test", "test");
  try {
    client.tracks = [{ hash, size: 10, mime: "audio/wav" }];
    client.connect();
    const frame = encodeChunk({ hash, from, to, index: 0, total: 1 }, new Uint8Array(9));
    client.ws.onmessage({ data: new Blob([frame]) });
    client.ws.onmessage({ data: new Uint8Array([1, 2, 3]).buffer });
    await nextTick();
    const d = client.diagnostics();
    assert.equal(d.rawBinaryMessages, 2);
    assert.equal(d.parsedFrames, 1);
    assert.equal(d.rejectedFrames, 2);
    assert.equal(d.lastRejectReason === "invalid-frame" ||
      d.lastRejectReason === "chunk-size-mismatch", true);
  } finally {
    client.close();
    if (original === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = original;
    if (oldLocation === undefined) delete globalThis.location;
    else globalThis.location = oldLocation;
  }
});
