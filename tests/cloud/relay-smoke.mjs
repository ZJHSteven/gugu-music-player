/**
 * 真实 Miniflare / Wrangler DO WebSocket 端到端测试。
 *
 * 先执行 npm run build:cloud && wrangler dev --local --port 8789，
 * 再运行 node tests/cloud/relay-smoke.mjs。
 *
 * 三个独立客户端模拟 GM、玩家 A、玩家 B，测试 2 MiB 和 30 MiB
 * 文件真实通过 DO 二进制中继，且 GM 离开后 A 仍可传给 B。
 *
 * 注意：这里不是 WebRTC。发送侧不保存 DO URL 之外的服务端文件副本，
 * 接收端必须对收齐的文件做 SHA-256 完整性检验。
 */
import assert from "node:assert/strict";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { encodeChunk, decodeChunk, CHUNK_SIZE } from "../../public/cloud/wire.js";

const base = process.env.GUGU_RELAY_URL || "ws://127.0.0.1:8789/relay";
// 公网跨境线路可能明显慢于本地 Miniflare；通过环境变量允许用 2+4 MiB
// 做较短的生产冒烟测试，同时保留默认 2+30 MiB 的完整压力测试。
const smallMiB = Number(process.env.GUGU_SMALL_MIB || 2);
const largeMiB = Number(process.env.GUGU_LARGE_MIB || 30);
if (![smallMiB, largeMiB].every((x) => x > 0 && x <= 64 && Number.isInteger(x))) {
  throw new Error("GUGU_SMALL_MIB / GUGU_LARGE_MIB 必须是 1～64 的整数");
}
const room = "smoke-" + randomUUID().slice(0, 12);
const key = randomBytes(16).toString("hex");
const url = `${base}?room=${room}&key=${key}`;

async function client() {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const messages = [];
  const listeners = new Set();
  ws.addEventListener("message", (e) => {
    const data = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
    messages.push(data);
    for (const listener of listeners) listener(data);
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const waitFor = (predicate, ms = 30000) => new Promise((resolve, reject) => {
    const existing = messages.find(predicate);
    if (existing) return resolve(existing);
    const timer = setTimeout(() => { listeners.delete(listener); reject(new Error("WebSocket 等待超时")); }, ms);
    const listener = (m) => { if (predicate(m)) { clearTimeout(timer); listeners.delete(listener); resolve(m); } };
    listeners.add(listener);
  });
  const welcome = await waitFor((m) => m?.t === "welcome");
  return { ws, peer: welcome.peer, waitFor };
}

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function transfer(from, to, bytes) {
  const hash = sha(bytes), count = Math.ceil(bytes.length / CHUNK_SIZE);
  from.ws.send(JSON.stringify({ t: "have", hashes: [hash] }));
  // 广播 available 同步后，接收方再通过 DO 选择下载源。
  await to.waitFor((m) => m?.t === "available" && m.hashes.includes(hash));
  to.ws.send(JSON.stringify({ t: "need", hash }));
  await from.waitFor((m) => m?.t === "serve" && m.hash === hash && m.to === to.peer);
  const parts = new Array(count);
  const result = new Promise((resolve, reject) => {
    const started = Date.now();
    const timeout = setTimeout(() => reject(new Error("30 MiB 中继没有完成")), 90000);
    const receiver = (e) => {
      if (typeof e.data === "string") return;
      const { header, bytes: payload } = decodeChunk(e.data);
      if (header.hash !== hash) return;
      parts[header.index] = Buffer.from(payload);
      if (parts.filter(Boolean).length === count) {
        clearTimeout(timeout);
        to.ws.removeEventListener("message", receiver);
        const received = Buffer.concat(parts);
        assert.equal(received.length, bytes.length);
        assert.equal(sha(received), hash);
        resolve(Date.now() - started);
      }
    };
    to.ws.addEventListener("message", receiver);
  });
  for (let index = 0; index < count; index++) {
    const first = index * CHUNK_SIZE;
    while (from.ws.bufferedAmount > 2 * 1024 * 1024) await new Promise((r) => setTimeout(r, 10));
    from.ws.send(encodeChunk({
      from: from.peer, to: to.peer, hash, index, total: count,
    }, bytes.subarray(first, first + CHUNK_SIZE)));
  }
  const duration = await result;
  console.log(`✓ ${(bytes.length / (1024 * 1024)).toFixed(1)} MiB 跨 DO 中继通过，${duration}ms，SHA-256 一致`);
  return hash;
}

const gm = await client();
const a = await client();
const b = await client();
try {
  await transfer(gm, a, randomBytes(smallMiB * 1024 * 1024));
  gm.ws.close();
  // 即使上传源 GM 离开，仍在房间中的玩家 A 可以继续作为源。
  await transfer(a, b, randomBytes(largeMiB * 1024 * 1024));
  console.log("✓ GM 下线后玩家之间文件互传通过");
} finally {
  gm.ws.close(); a.ws.close(); b.ws.close();
}
