/**
 * Cloudflare Durable Object 真实WebSocket端到端逐块ACK验证。
 *
 * 使用独立随机房间与程序生成的2,188,046B随机音频；不会访问用户真实
 * Owlbear房间，也不会持久化音频到云端。两名PLAYER同时取同一歌曲，
 * 模拟其中一人第4块的ACK丢失，验收重复块重发、端到端背压和SHA256。
 *
 * GUGU_RELAY_URL 默认 ws://127.0.0.1:8795/relay，也可指向正式公网
 * wss://music.zjhstudio.com/relay 做随机房间的无隐私集成测试。
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { decodeChunk } from "../../public/cloud/wire.js";
import { sendAudioWithAck } from "../../public/cloud/audio-sender.js";

const base = process.env.GUGU_RELAY_URL || "ws://127.0.0.1:8795/relay";
const room = `flow-${randomUUID().slice(0, 12)}`;
const key = randomBytes(16).toString("hex");
const url = `${base}?room=${room}&key=${key}`;
const bytes = randomBytes(2188046);
const hash = createHash("sha256").update(bytes).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect() {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const messages = [];
  const listeners = new Set();
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const msg = JSON.parse(event.data);
    messages.push(msg);
    for (const fn of listeners) fn(msg);
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  function until(predicate, ms = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(receive);
        reject(new Error("等待中继消息超时"));
      }, ms);
      function receive(msg) {
        if (!predicate(msg)) return;
        clearTimeout(timer);
        listeners.delete(receive);
        resolve(msg);
      }
      listeners.add(receive);
      for (const msg of messages) receive(msg);
    });
  }
  const peer = (await until((msg) => msg.t === "welcome")).peer;
  return { ws, peer, until };
}

const gm = await connect();
const players = await Promise.all([connect(), connect()]);
const started = Date.now();
const sendResults = [];

try {
  // 发送侧只在收到DO的serve后发送文件；每个收件人有独立ACK进度。
  gm.ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const msg = JSON.parse(event.data);
    if (msg.t !== "serve") return;
    assert.equal(msg.flowControl, "ack-v1", "DO必须向源端传递协商结果");
    sendResults.push(sendAudioWithAck({
      ws: gm.ws, file: new Blob([bytes]), hash,
      from: gm.peer, to: msg.to,
      ackTimeoutMs: 1800,
      waitForAck: (index, ms) => gm.until((entry) => entry.t === "ack" &&
        entry.from === msg.to && entry.hash === hash && entry.index === index, ms),
    }));
  });

  const completed = players.map((player, playerIndex) => new Promise((resolve, reject) => {
    const chunks = new Array(9);
    let droppedAck = false;
    const timeout = setTimeout(() => reject(new Error(
      `玩家${playerIndex}只收到 ${chunks.filter(Boolean).length}/9 块`
    )), 35000);
    player.ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") return;
      const { header, bytes: chunk } = decodeChunk(event.data);
      assert.equal(header.to, player.peer);
      assert.equal(header.from, gm.peer);
      chunks[header.index] ??= Buffer.from(chunk);
      // 玩家A故意丢弃一次ACK，数据重复到达后照样重发确认。
      if (playerIndex === 0 && header.index === 4 && !droppedAck) {
        droppedAck = true;
        return;
      }
      setTimeout(() => player.ws.send(JSON.stringify({
        t: "ack", hash, to: gm.peer, index: header.index,
      })), 30);
      // 稀疏数组的every()会跳过未初始化的空位，不可拿它当9/9块已到。
      if (chunks.filter(Boolean).length === 9) {
        clearTimeout(timeout);
        const assembled = Buffer.concat(chunks);
        assert.equal(assembled.length, bytes.length);
        assert.equal(createHash("sha256").update(assembled).digest("hex"), hash);
        resolve({ playerIndex, droppedAck });
      }
    });
  }));

  gm.ws.send(JSON.stringify({ t: "have", hashes: [hash] }));
  await Promise.all(players.map((player) => player.until(
    (msg) => msg.t === "available" && msg.hashes.includes(hash)
  )));
  players.forEach((player) => player.ws.send(JSON.stringify({
    t: "need", hash, flowControl: "ack-v1",
  })));
  const received = await Promise.all(completed);
  // 等待发送侧全部确认最后一块，而不仅是接收者拼包完成。
  await sleep(300);
  assert.equal(sendResults.length, 2);
  assert.deepEqual(await Promise.all(sendResults), [true, true]);
  assert.equal(received[0].droppedAck, true);
  console.log(`✓ 2×2,188,046B实时DO并行接收、逐块ACK、丢ACK重发、SHA256校验全通过 (${Date.now()-started}ms)`);
} finally {
  gm.ws.close();
  players.forEach((player) => player.ws.close());
}
