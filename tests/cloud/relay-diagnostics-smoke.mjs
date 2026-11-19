/**
 * 真正 Durable Object 临时连接诊断验收。
 *
 * 使用随机 room/key，不接触用户的三个真实 Owlbear 房间：
 * 1. 两个独立连接获得 welcome.peer。
 * 2. 接收方请求已存在文件，DO 记录 needCount。
 * 3. 发送方真正转发音频块，DO 的 sentBytes/forwardedBytes 同步增加。
 * 4. 接收方重组后 SHA256 校验通过，再发 verified。
 * 5. GET /relay-diagnostics 能读出匿名 peer 的 verifiedCount。
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { sendAudioWithoutAck } from "../../public/cloud/audio-sender.js";
import { decodeChunk } from "../../public/cloud/wire.js";

const base = process.env.GUGU_RELAY_URL || "ws://127.0.0.1:8796/relay";
const room = `diag-${randomUUID().slice(0, 10)}`;
const key = randomBytes(16).toString("hex");
const qs = new URLSearchParams({ room, key });
const wsUrl = `${base}?${qs}`;
const diagnosticUrl =
  `${base.replace(/^ws/, "http").replace(/\/relay$/, "/relay-diagnostics")}${"?"}${qs}`;

async function connect() {
  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";
  const events = [];
  ws.addEventListener("message", (ev) => {
    events.push(typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data);
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const until = async (fn) => {
    const end = Date.now() + 12000;
    while (Date.now() < end) {
      const item = events.find(fn);
      if (item) return item;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("WS event timeout");
  };
  return { ws, until, peer: (await until((x) => x?.t === "welcome")).peer };
}

const source = await connect();
const receiver = await connect();
try {
  const payload = randomBytes(640 * 1024 + 17);
  const hash = createHash("sha256").update(payload).digest("hex");
  source.ws.send(JSON.stringify({ t: "have", hashes: [hash] }));
  await receiver.until((x) => x?.t === "available" && x.hashes?.includes(hash));
  receiver.ws.send(JSON.stringify({ t: "need", hash }));
  await source.until((x) => x?.t === "serve" && x.hash === hash);

  const bytes = [];
  let received = 0;
  receiver.ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") return;
    const { header, bytes: chunk } = decodeChunk(ev.data);
    bytes[header.index] = Buffer.from(chunk);
    received += chunk.byteLength;
    if (received === payload.length) {
      assert.equal(createHash("sha256").update(Buffer.concat(bytes)).digest("hex"), hash);
      receiver.ws.send(JSON.stringify({ t: "verified", hash }));
    }
  });
  const sent = await sendAudioWithoutAck({
    ws: source.ws, file: new Blob([payload]), hash,
    from: source.peer, to: receiver.peer,
  });
  assert.equal(sent, true);

  let status;
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    const response = await fetch(diagnosticUrl);
    assert.equal(response.status, 200);
    status = await response.json();
    if (status.clients.some((p) => p.peer === receiver.peer.slice(0, 12) &&
        p.verifiedCount === 1)) break;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.equal(status.connections, 2);
  const senderStats = status.clients.find((p) => p.peer === source.peer.slice(0, 12));
  const receiverStats = status.clients.find((p) => p.peer === receiver.peer.slice(0, 12));
  assert.ok(senderStats.sentBytes >= payload.length);
  assert.equal(receiverStats.needCount, 1);
  assert.ok(receiverStats.forwardedBytes >= payload.length);
  assert.equal(receiverStats.verifiedCount, 1);
  assert.equal(receiverStats.verifiedHash, hash.slice(0, 10));
  assert.ok(!JSON.stringify(status).includes(key), "状态接口绝不可泄漏 room secret");
  console.log(`✓ 两连接、${payload.length}B 中继、客户端verified确认、匿名连接统计全部正确`);
} finally {
  source.ws.close();
  receiver.ws.close();
}
