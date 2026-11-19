/**
 * 真正的 Durable Object WebSocket 测试：验证大于 2 MiB 的文件
 * 在接收端完全不发应用层 ACK 时仍可可靠到达。
 *
 * 启动本地 Worker 后执行：
 *   $env:GUGU_RELAY_URL='ws://127.0.0.1:8795/relay'
 *   node tests/cloud/relay-ackless-smoke.mjs
 *
 * 测试仅使用随机房间与生成的数据，不接触用户的 Owlbear 房间或歌单。
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { decodeChunk } from "../../public/cloud/wire.js";
import { sendAudioWithoutAck } from "../../public/cloud/audio-sender.js";

const base = process.env.GUGU_RELAY_URL || "ws://127.0.0.1:8795/relay";
const room = `ackless-${randomUUID().slice(0, 12)}`;
const key = randomBytes(16).toString("hex");
const uri = `${base}?room=${room}&key=${key}`;
const bytes = randomBytes(3 * 1024 * 1024 + 17);
const hash = createHash("sha256").update(bytes).digest("hex");
const deadline = 30_000;

const connect = async () => {
  const ws = new WebSocket(uri);
  ws.binaryType = "arraybuffer";
  const queue = [];
  const listeners = new Set();
  ws.addEventListener("message", (event) => {
    const entry = typeof event.data === "string"
      ? JSON.parse(event.data)
      : event.data;
    queue.push(entry);
    for (const listener of listeners) listener(entry);
  });
  const until = (predicate) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listeners.delete(receive);
      reject(new Error("WebSocket message timeout"));
    }, deadline);
    const receive = (entry) => {
      if (!predicate(entry)) return;
      clearTimeout(timer);
      listeners.delete(receive);
      resolve(entry);
    };
    listeners.add(receive);
    for (const entry of queue) receive(entry);
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const welcome = await until((message) => message?.t === "welcome");
  return { ws, peer: welcome.peer, until };
};

const sender = await connect();
const recipient = await connect();
try {
  sender.ws.send(JSON.stringify({ t: "have", hashes: [hash] }));
  await recipient.until((msg) => msg?.t === "available" && msg.hashes?.includes(hash));
  recipient.ws.send(JSON.stringify({ t: "need", hash }));
  await sender.until((msg) => msg?.t === "serve" && msg.hash === hash);

  const received = [];
  let receivedBytes = 0;
  const finished = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(
      `未完整到达：${receivedBytes} / ${bytes.length} 字节`
    )), deadline);
    recipient.ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") return;
      const { header, bytes: chunk } = decodeChunk(event.data);
      assert.equal(header.from, sender.peer);
      assert.equal(header.to, recipient.peer);
      assert.equal(header.hash, hash);
      received[header.index] = Buffer.from(chunk);
      receivedBytes += chunk.byteLength;
      // 故意不发送任何 ACK，复现真实远程用户卡在第 8 块的场景。
      if (receivedBytes === bytes.length) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  const start = Date.now();
  assert.equal(await sendAudioWithoutAck({
    ws: sender.ws, file: new Blob([bytes]), hash,
    from: sender.peer, to: recipient.peer,
  }), true);
  await finished;
  const payload = Buffer.concat(received);
  assert.equal(payload.length, bytes.length);
  assert.equal(createHash("sha256").update(payload).digest("hex"), hash);
  console.log(`✓ DO 真实中继 + 无 ACK：${payload.length} 字节完整接收，SHA-256 一致，耗时 ${Date.now()-start} ms`);
} finally {
  sender.ws.close();
  recipient.ws.close();
}
