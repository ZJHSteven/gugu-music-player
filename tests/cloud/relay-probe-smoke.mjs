/**
 * 用真实DO WebSocket验证一次用户手动触发的链路探针。
 *
 * 既验证一条短文本消息，也验证一个256KiB真实二进制消息能从DO
 * 回到同一连接；这是为了排查「WSS显示OPEN，实际二进制数据却收不到」。
 * 使用随机测试房间，绝不访问或修改真实Owlbear房间。
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { decodeChunk, CHUNK_SIZE } from "../../public/cloud/wire.js";

const base = process.env.GUGU_RELAY_URL || "ws://127.0.0.1:8795/relay";
const room = `probe-${randomUUID().slice(0, 12)}`;
const key = randomBytes(16).toString("hex");
const nonce = randomBytes(6).toString("hex");
const ws = new WebSocket(`${base}?room=${room}&key=${key}`);
ws.binaryType = "arraybuffer";
let textReceived = false;
let binaryReceived = false;
const result = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("4.5秒探针未完成")), 4500);
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      const msg = JSON.parse(event.data);
      if (msg.t === "welcome") ws.send(JSON.stringify({ t: "probe", nonce }));
      if (msg.t === "probe-ack" && msg.nonce === nonce) textReceived = true;
    } else {
      const { header, bytes } = decodeChunk(event.data);
      assert.equal(header.hash, "0".repeat(64));
      assert.equal(header.probe, nonce);
      assert.equal(bytes.byteLength, CHUNK_SIZE);
      assert.equal(bytes[0], 0x5a);
      assert.equal(bytes[CHUNK_SIZE - 1], 0x5a);
      binaryReceived = true;
    }
    if (textReceived && binaryReceived) { clearTimeout(timer); resolve(); }
  });
  ws.addEventListener("error", reject, { once: true });
});
try {
  await result;
  console.log("✓ 云端WS实时探针：文本ACK + 256KiB二进制下行全部送达");
} finally {
  ws.close();
}
