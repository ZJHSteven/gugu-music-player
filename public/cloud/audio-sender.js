/**
 * 云版音频分块发送。
 *
 * 真实跨设备测试表明：严格等待每 8 个分块的应用层 ACK，可能使发送端
 * 永久卡在 2 MiB 窗口边界；接收端即使收到了部分数据，也无法播放。
 *
 * 这里使用 WebSocket 自带的有序可靠传输，以及 bufferedAmount 队列背压。
 * 分组之间只做短暂让步，不再等待另一端是否实现了自定义 ACK 协议。
 *
 * 此函数不写本地/远端文件、不储存到 Cloudflare、不信任文件已成功；
 * 接收端仍需重新组装全部字节并验证 SHA-256 后才能真正使用音频。
 */
import { CHUNK_SIZE, MAX_AUDIO_SIZE, encodeChunk } from "./wire.js";

const QUEUED_LIMIT = 2 * 1024 * 1024;
const YIELD_GROUP = 8;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ws:WebSocket, file:Blob, hash:string, from:string, to:string}} opts
 * @returns {Promise<boolean>} 成功排入本地 WebSocket 则 true，断线则 false。
 * 注意：true 不代表远端已经收到、校验通过或实际开始播放。
 */
export async function sendAudioWithoutAck({ ws, file, hash, from, to }) {
  if (!(file instanceof Blob) || !file.size || file.size > MAX_AUDIO_SIZE) {
    throw new Error("音频文件缺失或超过允许大小");
  }
  const total = Math.ceil(file.size / CHUNK_SIZE);
  for (let index = 0; index < total; index++) {
    if (!ws || ws.readyState !== 1) return false;
    // 不能把 30 MiB / 64 MiB 文件瞬间全部排进 WebSocket 浏览器内存。
    // 这里控制的是发送队列里的字节数，与对端应用层 ACK 是否存在无关。
    while (ws.bufferedAmount > QUEUED_LIMIT) {
      if (ws.readyState !== 1) return false;
      await sleep(25);
    }
    const chunk = new Uint8Array(await file.slice(
      index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE
    ).arrayBuffer());
    if (ws.readyState !== 1) return false;
    ws.send(encodeChunk({ from, to, hash, index, total }, chunk));
    // 组间让出一次事件循环，让浏览器处理 WebSocket 收发及 UI。
    // 绝不因为对端没有发送 ACK 就暂停整个文件的余下分块。
    if ((index + 1) % YIELD_GROUP === 0 || index + 1 === total) await sleep(25);
  }
  return true;
}
