/**
 * 只读、手动触发的玩家诊断报告。
 *
 * 设计原则：
 * 1. 任何用户（GM / PLAYER）都能在音乐面板里点击「生成诊断」。
 * 2. 不自动上传用户浏览器日志。报告由用户主动复制并发给排障人员。
 * 3. 使用字段白名单，不直接 JSON.stringify(room metadata / WebSocket URL)；
 *    两者可能包含房间密钥、个人身份和其他扩展的敏感数据。
 * 4. 浏览器的媒体错误与服务器的「已转发字节」必须明确区分。
 */

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function short(value, max = 12) {
  return /^[a-zA-Z0-9_-]+$/.test(String(value || ""))
    ? String(value).slice(0, max) : null;
}

function eventSummary(value) {
  if (!Array.isArray(value)) return [];
  const types = new Set([
    "connected", "disconnected", "socket-error", "identified",
    "request", "timeout", "error", "unavailable", "sent-queued", "verified",
    "media-error", "playing", "pause", "waiting", "seeking", "play-rejected",
  ]);
  return value.slice(-20).filter((e) => types.has(e?.type)).map((e) => ({
    at: /^\d{4}-\d{2}-\d{2}T/.test(e.at || "") ? e.at : null,
    event: e.type,
    hash: short(e.hash, 10),
    errorName: short(e.name, 40),
    bytes: finite(e.bytes),
    code: finite(e.code),
    position: finite(e.position),
  }));
}

function relayStatus(r) {
  if (!r) return null;
  return {
    connected: Boolean(r.connected),
    socketState: finite(r.socketState),
    connectionCode: short(r.peer, 12),
    pendingBytes: finite(r.bufferedSendBytes),
    owned: finite(r.ownedCount),
    waiting: finite(r.requestedCount),
    requests: finite(r.requested),
    bytesReceived: finite(r.receivedBytes),
    filesVerified: finite(r.verified),
    reconnects: finite(r.reconnects),
    timeouts: finite(r.timeouts),
    unavailable: finite(r.unavailable),
    files: (r.files || []).slice(0, 12).map((f) => ({
      hash: short(f.hash, 10),
      expectedBytes: finite(f.expectedBytes),
      receivedBytes: finite(f.receivedBytes),
      cached: Boolean(f.cached),
      requested: Boolean(f.requested),
      receivedChunks: finite(f.receivedChunks),
      totalChunks: finite(f.totalChunks),
    })),
    recentEvents: eventSummary(r.events),
  };
}

function mediaStatus(m) {
  if (!m) return null;
  return {
    paused: Boolean(m.paused),
    ended: Boolean(m.ended),
    seeking: Boolean(m.seeking),
    muted: Boolean(m.muted),
    volume: finite(m.volume),
    currentTime: finite(m.currentTime),
    duration: finite(m.duration),
    readyState: finite(m.readyState),
    networkState: finite(m.networkState),
    mediaErrorCode: finite(m.errorCode),
    playError: short(m.errorName, 40),
    blocked: Boolean(m.blocked),
    buffering: Boolean(m.buffering),
    playbackRate: finite(m.rate),
  };
}

function serverStatus(server) {
  if (!server) return null;
  return {
    connectedPeers: finite(server.connections),
    // 在 HTTP 层也仅返回 12 字符的匿名短连接号。
    peers: (server.clients || []).slice(0, 48).map((p) => ({
      code: short(p.peer, 12),
      hasFiles: finite(p.hasFiles),
      needCount: finite(p.needCount),
      needHash: short(p.needHash, 10),
      sentBytes: finite(p.sentBytes),
      forwardedBytes: finite(p.forwardedBytes),
      verifiedCount: finite(p.verifiedCount),
      verifiedHash: short(p.verifiedHash, 10),
    })),
  };
}

function environment(ua = "") {
  const name = /Firefox\//.test(ua) ? "Firefox" :
    /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" :
      /Safari\//.test(ua) ? "Safari" : "其他浏览器";
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad|iPod/i.test(ua) ?
    "iOS/iPadOS" : /Windows/i.test(ua) ? "Windows" :
      /Macintosh|Mac OS/i.test(ua) ? "macOS" : /Linux/i.test(ua) ? "Linux" : "未知";
  return { browser: name, system: os };
}

/**
 * 返回报告纯文本。绝不将参数原对象原样复制进报告。
 * source.server 可以是本人凭已有 relay secret 主动请求得到的临时 DO 状态。
 */
export function makeDiagnosticReport(source) {
  const p = source || {};
  const engine = p.engine || {};
  const report = {
    version: "3.2.3",
    generatedAt: new Date().toISOString(),
    ...environment(p.userAgent),
    roomRole: p.role === "GM" ? "GM" : "PLAYER",
    hasMusicSession: Boolean(p.hasMusicSession),
    revision: finite(p.revision),
    trackLoaded: Boolean(p.trackLoaded),
    trackDuration: finite(p.trackDuration),
    playingInRoom: Boolean(p.playingInRoom),
    engine: {
      kind: engine.engineKind === "background" ? "background" :
        engine.engineKind === "popover" ? "popover" : "unavailable",
      media: mediaStatus(engine.media),
      events: eventSummary(engine.mediaEvents),
    },
    relayInAudioEngine: relayStatus(engine.relay),
    relayInPanel: relayStatus(p.panelRelay),
    relayAtCloudflare: serverStatus(p.server),
    diagnosticsError: p.diagnosticsError ? "DO 状态读取失败或超时" : null,
  };
  return "咕咕点歌台 · 匿名播放诊断\n" +
    "注意：连接转发≠文件校验完成≠浏览器真正发声。\n" +
    "以下内容不含房间密钥、账号、房间地址、歌曲名称或音频数据。\n\n" +
    JSON.stringify(report, null, 2);
}
