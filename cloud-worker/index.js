/**
 * Cloudflare Workers + 可休眠 Durable Object 纯中继。
 *
 * - 每个房间/随机 secret 得到确定的 DO 实例；无音频对象存储，无数据库读写。
 * - 每条 WebSocket 的 serializeAttachment 存节点 ID 和可供应的内容哈希，
 *   DO 被 Cloudflare 休眠/重建之后仍能找回在线节点及其可用歌曲。
 * - 不使用 Web Standard WebSocket.accept()、setInterval、alarms 或外呼连接：
 *   所有长连接均经 DurableObjectState.acceptWebSocket()，因此闲置可休眠。
 * - 只读二进制头转发 256 KiB 音频块，拒绝超大或非法数据；接收端 SHA-256 校验。
 *
 * 房间 secret 由 Owlbear Room Metadata 生成并分发。只有房间成员通常知道它，
 * 但它不是 Owlbear 官方签名认证，无法防范有意泄露密钥的房间内成员。
 */
import { DurableObject } from "cloudflare:workers";
import { decodeChunk, HASH_RE, PEER_RE } from "../public/cloud/wire.js";

const roomPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const keyPattern = /^[a-f0-9]{32}$/;
const MAX_CONNECTIONS = 48;
const MAX_HASHES = 160;

/** 通过消息内容匹配合法类型，避免恶意对象塞入过多任意字段。 */
function validHashes(list) {
  return Array.isArray(list) ? [...new Set(list.filter((x) => HASH_RE.test(x)))].slice(0, MAX_HASHES) : [];
}

export class RoomRelay extends DurableObject {
  /** 这是唯一的 DO HTTP 调用：WebSocket upgrade。 */
  async fetch(request) {
    // 显式请求才生成的临时诊断快照：不上传音频、不保存用户身份，
    // 不产生周期轮询。访问者必须已经拥有此房间的临时中继 secret。
    if (new URL(request.url).pathname === "/relay-diagnostics") {
      const clients = this.peers().map(({ info }) => ({
        // 连接号与播放器界面显示一致，可让用户说“我的是 A1B2...”。
        // 不提供 Owlbear 玩家姓名、账号、IP 或房间密钥。
        peer: (info.peer || "").slice(0, 12),
        connectedAt: info.connectedAt || null,
        lastSeenAt: info.lastSeenAt || null,
        hasFiles: info.hashes?.length || 0,
        needCount: info.needCount || 0,
        needHash: info.needHash || null,
        sentBytes: info.sentBytes || 0,
        forwardedBytes: info.forwardedBytes || 0,
        verifiedCount: info.verifiedCount || 0,
        verifiedHash: info.verifiedHash || null,
        verifiedAt: info.verifiedAt || null,
      }));
      return Response.json({ version: 1, generatedAt: Date.now(),
        connections: clients.length, clients }, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }
    if (this.ctx.getWebSockets().length >= MAX_CONNECTIONS) {
      return new Response("Room is full", { status: 429 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      peer: crypto.randomUUID(), hashes: [], connectedAt: Date.now(),
      needCount: 0, sentBytes: 0, forwardedBytes: 0, verifiedCount: 0,
    });
    server.send(JSON.stringify({ t: "welcome", peer: server.deserializeAttachment().peer }));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** 动态读取附件而不是在构造函数中缓存在线成员，保证休眠唤醒后仍然正确。 */
  peers() {
    return this.ctx.getWebSockets().map((ws) => ({
      ws, info: ws.deserializeAttachment() || {},
    }));
  }

  /** 除二进制块以外，只允许极小的控制帧。 */
  async webSocketMessage(sender, message) {
    const me = sender.deserializeAttachment() || {};
    if (!PEER_RE.test(me.peer || "")) return;

    if (typeof message !== "string") {
      try {
        const { header } = decodeChunk(message);
        // DO 不接受尚未声明拥有哈希的发送者，也不接受向自己发包。
        if (!me.hashes?.includes(header.hash) ||
            header.to === me.peer || header.from !== me.peer) return;
        const peer = this.peers().find((p) => p.info.peer === header.to);
        if (peer) {
          peer.ws.send(message);
          // Hibernation attachment 保存每条连接的临时统计，不是 DO 持久化
          // 文件，也不是按块写数据库。这里只累计经过 DO 的有效字节。
          const bytes = message.byteLength ?? message.length ?? 0;
          sender.serializeAttachment({ ...me,
            sentBytes: (me.sentBytes || 0) + bytes, lastSeenAt: Date.now() });
          peer.ws.serializeAttachment({ ...peer.info,
            forwardedBytes: (peer.info.forwardedBytes || 0) + bytes,
            lastSeenAt: Date.now() });
        }
      } catch {
        sender.send(JSON.stringify({ t: "error", reason: "invalid-chunk" }));
      }
      return;
    }

    if (message.length > 8192) return;
    let data;
    try { data = JSON.parse(message); } catch { return; }
    if (!data || typeof data !== "object") return;

    switch (data.t) {
      case "have": {
        const hashes = validHashes(data.hashes);
        sender.serializeAttachment({ ...me, hashes, lastSeenAt: Date.now() });
        // 仅在节点登记时发一次摘要列表，平时不扫描、不轮询。
        for (const peer of this.peers()) {
          if (peer.info.peer !== me.peer && hashes.length) {
            peer.ws.send(JSON.stringify({ t: "available", hashes }));
          }
        }
        break;
      }
      case "need": {
        if (!HASH_RE.test(data.hash)) return;
        sender.serializeAttachment({ ...me,
          needCount: (me.needCount || 0) + 1,
          needHash: data.hash.slice(0, 10), lastSeenAt: Date.now() });
        const source = this.peers().find(
          (p) => p.info.peer !== me.peer && p.info.hashes?.includes(data.hash)
        );
        if (source) {
          source.ws.send(JSON.stringify({ t: "serve", hash: data.hash, to: me.peer }));
        } else {
          sender.send(JSON.stringify({ t: "unavailable", hash: data.hash }));
        }
        break;
      }
      case "verified": {
        // 只有接收端已完成本地 SHA-256 校验、保存文件后才发送此消息。
        // 这是客户端上报的成功事件，不代表已经调用 audio.play() 或出声。
        if (!HASH_RE.test(data.hash)) return;
        sender.serializeAttachment({ ...me,
          verifiedCount: (me.verifiedCount || 0) + 1,
          verifiedHash: data.hash.slice(0, 10),
          verifiedAt: Date.now(), lastSeenAt: Date.now() });
        break;
      }
      case "done": {
        if (!HASH_RE.test(data.hash) || !PEER_RE.test(data.to)) return;
        if (!me.hashes?.includes(data.hash)) return;
        const dest = this.peers().find((p) => p.info.peer === data.to);
        dest?.ws.send(JSON.stringify({ t: "done", hash: data.hash }));
        break;
      }
      case "ack": {
        // 接收者每收到一组音频块只回一次 ACK。DO 只转发 ACK，绝不持有文件。
        if (!HASH_RE.test(data.hash) || !PEER_RE.test(data.to) ||
            !Number.isInteger(data.index) || data.index < 0 || data.index > 255) return;
        const source = this.peers().find(
          (p) => p.info.peer === data.to && p.info.hashes?.includes(data.hash)
        );
        source?.ws.send(JSON.stringify({
          t: "ack", hash: data.hash, from: me.peer, index: data.index,
        }));
        break;
      }
      default: break;
    }
  }

  async webSocketClose() {
    // Cloudflare 在较新兼容日期自动完成 close 握手。
    // 此处不维护 JS 成员 Map，ctx.getWebSockets() 会自动移除断线。
  }

  async webSocketError() {
    // 错误连接由运行时关闭；其他连接以及持久附件不受影响。
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/relay" && url.pathname !== "/relay-diagnostics") {
      return env.ASSETS.fetch(request);
    }

    // 防止其他站点的普通网页借助用户浏览器滥用中继。
    // 此 Origin 校验不是用户认证；非浏览器客户端可能伪造 Origin。
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return new Response("Origin denied", { status: 403 });
    if (url.pathname === "/relay" &&
        request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }
    const room = url.searchParams.get("room") || "";
    const key = url.searchParams.get("key") || "";
    if (!roomPattern.test(room) || !keyPattern.test(key)) {
      return new Response("Invalid room", { status: 400 });
    }
    // 房间名和随机 secret 共同决定 DO 名字，不把 secret 写进任何 DO 数据库。
    const stub = env.ROOM_RELAY.getByName(`gugu-v1:${room}:${key}`);
    return stub.fetch(request);
  },
};
