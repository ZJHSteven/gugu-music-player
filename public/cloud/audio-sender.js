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

/**
 * 新版接收端主动声明 ack-v1 后才使用的逐块确认发送。
 *
 * 背景：过去发送方只约束「自己→Cloudflare」的 bufferedAmount，无法知道
 * Cloudflare→远端 Edge 的浏览器是否真正收到二进制块。DO 因而可能不断排队
 * 转发完整文件，而慢客户端仅收到最初几块。逐块确认是端到端背压：在对端
 * 明确接收上一个 256KiB 块之前，绝不向 DO 排入下一块。
 *
 * ACK 可以比等待注册更早到达：负责管理 ACK 高水位的调用方必须缓存它。
 * ACK 丢失时重发同一序号、同一内容；接收端也必须给重复块再次 ACK。
 * 这里的 ACK 只证明块已进接收端 JS 内存，最终 SHA-256 和持久存储仍在
 * 接收端完成，不能等同于 verified 或实际播放声音。
 */
export async function sendAudioWithAck({ ws, file, hash, from, to, waitForAck,
  onRetry = () => {}, ackTimeoutMs = 5000, maxAttempts = 4 }) {
  if (!(file instanceof Blob) || !file.size || file.size > MAX_AUDIO_SIZE) {
    throw new Error("音频文件缺失或超过允许大小");
  }
  if (typeof waitForAck !== "function" || !Number.isFinite(ackTimeoutMs) ||
      ackTimeoutMs <= 0 || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("端到端音频流控参数无效");
  }
  const total = Math.ceil(file.size / CHUNK_SIZE);
  for (let index = 0; index < total; index++) {
    const bytes = new Uint8Array(await file.slice(
      index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE
    ).arrayBuffer());
    // 重试同一块时共用完全相同的帧内容，避免因异步读文件产生数据差异。
    const frame = encodeChunk({ from, to, hash, index, total }, bytes);
    let acknowledged = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (!ws || ws.readyState !== 1) return false;
      // 每轮仅在上一块确认为止才发送下一块，天然约束DO下游队列长度。
      ws.send(frame);
      try {
        await waitForAck(index, ackTimeoutMs);
        acknowledged = true;
        break;
      } catch (error) {
        if (ws.readyState !== 1) return false;
        if (attempt === maxAttempts) {
          throw new Error(`音频分块 ${index + 1}/${total} 等待确认超时（已重试）`,
            { cause: error });
        }
        onRetry(index, attempt);
      }
    }
    if (!acknowledged) return false;
  }
  return true;
}
