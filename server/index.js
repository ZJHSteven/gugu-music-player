// 咕咕点歌台 —— 服务端（零依赖，Node 18+）
//
//   node server/index.js [--port 8787] [--data ./data] [--admin-key xxx] [--preload "歌.mp3"]
//
// 做四件事：托管扩展页面 / 存 GM 上传的音乐并按 Range 分发 / 代理 B 站音轨 / 同步播放状态。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

import { Store, uid, cleanRoomId, cleanFolder, buildNow, buildState } from "./rooms.js";
import { initLog, log, logError, logQuiet } from "./log.js";
import { resolveBilibili, refreshBilibili, BILI_HEADERS } from "./bilibili.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");

// ---------- 配置 ----------
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(arg("port", process.env.PORT || 8787));
const HOST = arg("host", "0.0.0.0");
const DATA_DIR = path.resolve(arg("data", process.env.DATA_DIR || path.join(ROOT, "data")));
const ADMIN_KEY = arg("admin-key", process.env.MUSIC_ADMIN_KEY || "");
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 80) * 1024 * 1024;
const PRELOAD = arg("preload", process.env.PRELOAD_FILE || "");
const VERBOSE = argv.includes("--verbose") || process.env.VERBOSE === "1";

const store = new Store(DATA_DIR);
initLog(DATA_DIR);

// ---------- MIME / 上传白名单 ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
};
const AUDIO = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
};
const mimeFor = (p) => MIME[path.extname(p).toLowerCase()] || "application/octet-stream";
const audioMimeFor = (p) => AUDIO[path.extname(p).toLowerCase()] || "";
const isAudio = (p) => Boolean(audioMimeFor(p));

/** 按文件头判断真实类型（很多人把 mp4 改名成 .aac）。 */
function sniffAudio(file) {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    const s = buf.toString("latin1");
    if (s.slice(4, 8) === "ftyp") return /m4a|mp4|iso|dash|msnv|qt/i.test(s.slice(8, 12)) ? "audio/mp4" : "";
    if (buf[0] === 0xff && (buf[1] === 0xf1 || buf[1] === 0xf9)) return "audio/aac";
    if (buf[0] === 0xff && [0xfb, 0xf3, 0xf2].includes(buf[1])) return "audio/mpeg";
    if (s.startsWith("ID3")) return "audio/mpeg";
    if (s.startsWith("OggS")) return "audio/ogg";
    if (s.startsWith("RIFF")) return "audio/wav";
    if (s.startsWith("fLaC")) return "audio/flac";
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "audio/webm";
  } catch {}
  return "";
}

// ---------- HTTP 小工具 ----------
function cors(req, res) {
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  if (origin) res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

function json(req, res, status, body) {
  if (res.writableEnded) return;
  const data = Buffer.from(JSON.stringify(body ?? {}));
  cors(req, res);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
  });
  res.end(data);
}

const text = (req, res, status, body) => {
  const data = Buffer.from(String(body), "utf8");
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": data.length });
  res.end(data);
};

const readJson = (req, limit = 512 * 1024) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) return reject(Object.assign(new Error("请求体过大"), { statusCode: 413 }));
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("JSON 解析失败"), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });

const parseUrl = (req) => {
  const raw = req.url || "/";
  const i = raw.indexOf("?");
  return i === -1
    ? { pathname: raw, search: new URLSearchParams() }
    : { pathname: raw.slice(0, i), search: new URLSearchParams(raw.slice(i + 1)) };
};

function serveStatic(req, res, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return text(req, res, 400, "Bad path"), true;
  }
  if (rel.endsWith("/")) rel += "index.html";
  const abs = path.resolve(PUBLIC_DIR, "." + path.posix.normalize(rel));
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) return text(req, res, 403, "Forbidden"), true;

  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return false;
  }
  if (stat.isDirectory()) return serveStatic(req, res, rel.replace(/\/?$/, "/") + "index.html");

  const ext = path.extname(abs).toLowerCase();
  const noCache = [".html", ".json", ".js", ".css"].includes(ext);
  res.writeHead(200, {
    "Content-Type": mimeFor(abs),
    "Content-Length": stat.size,
    "Cache-Control": noCache ? "no-cache" : "public, max-age=300",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Private-Network": "true",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  fs.createReadStream(abs).pipe(res);
  return true;
}

/** 本地文件 + Range（拖进度条依赖）。 */
function serveFileRange(req, res, absPath, contentType) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return false;
  }
  cors(req, res);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", contentType || mimeFor(absPath));
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.setHeader("X-Content-Type-Options", "nosniff");

  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { "Content-Length": stat.size });
    if (req.method === "HEAD") return res.end(), true;
    fs.createReadStream(absPath).pipe(res);
    return true;
  }

  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) {
    res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
    res.end();
    return true;
  }
  let start = m[1] === "" ? stat.size - Number(m[2]) : Number(m[1]);
  let end = m[2] === "" || m[1] === "" ? stat.size - 1 : Number(m[2]);
  if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start > end || start >= stat.size) {
    res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
    res.end();
    return true;
  }
  end = Math.min(end, stat.size - 1);
  res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": end - start + 1 });
  if (req.method === "HEAD") return res.end(), true;
  fs.createReadStream(absPath, { start, end }).pipe(res);
  return true;
}

function pipeUpstream(req, res, upstream, contentType) {
  const headers = {
    "Content-Type": contentType || upstream.headers.get("content-type") || "application/octet-stream",
    "Cache-Control": "no-store",
    "Accept-Ranges": upstream.headers.get("accept-ranges") || "bytes",
  };
  for (const [from, to] of [
    ["content-length", "Content-Length"],
    ["content-range", "Content-Range"],
  ]) {
    const v = upstream.headers.get(from);
    if (v) headers[to] = v;
  }
  cors(req, res);
  res.writeHead(upstream.status, headers);
  if (req.method === "HEAD" || !upstream.body) {
    res.end();
    return true;
  }
  const stream = Readable.fromWeb(upstream.body);
  stream.on("error", () => res.destroy());
  req.on("close", () => stream.destroy());
  stream.pipe(res);
  return true;
}

// ---------- SSE 广播 ----------
const subs = new Map(); // roomId -> Set<{res, gm}>

// 长轮询等待者：反向代理会把 SSE 缓冲住，但「会结束的普通响应」一定送得到。
// 请求挂在这儿，一有状态变化立刻回包，客户端拿到就发下一个。
const waiters = new Map(); // roomId -> Set<{res, gm, timer}>

function resolveWaiters(roomId) {
  const set = waiters.get(roomId);
  if (!set?.size) return;
  const room = store.get(roomId);
  const now = buildNow(room);
  let state = "";
  try {
    state = JSON.stringify(buildState(room));
  } catch {}
  for (const w of set) {
    try {
      clearTimeout(w.timer);
      const payload = { seq: room.playback.seq, now };
      if (w.gm && state) payload.state = JSON.parse(state);
      json(w.req, w.res, 200, payload);
    } catch {}
  }
  set.clear();
}

function publish(roomId) {
  const set = subs.get(roomId);
  if (set?.size) {
    const room = store.get(roomId);
    const nowFrame = `event: now\ndata: ${JSON.stringify(buildNow(room))}\n\n`;
    let stateFrame = "";
    try {
      stateFrame = `event: state\ndata: ${JSON.stringify(buildState(room))}\n\n`;
    } catch {}
    for (const c of set) {
      try {
        if (c.gm && stateFrame) c.res.write(stateFrame);
        c.res.write(nowFrame);
      } catch {
        set.delete(c);
      }
    }
  }
  resolveWaiters(roomId);
  scheduleAutoAdvance(roomId);
}

// 服务端按时长自动切歌：GM 关页面音乐也不会断在半路
const roomTimers = new Map();
function scheduleAutoAdvance(roomId) {
  if (roomTimers.has(roomId)) clearTimeout(roomTimers.get(roomId));
  roomTimers.delete(roomId);
  const room = store.get(roomId);
  const p = room.playback;
  if (!p.playing || !p.trackId) return;
  const track = room.playlist.find((t) => t.id === p.trackId);
  const duration = Number(track?.duration || 0);
  if (!duration) return; // 时长未知就交给 GM 客户端的 ended
  const remaining = duration - store.position(room);
  if (remaining <= 0.2) {
    // 已经播到（或越过）结尾——典型情况是把进度条拖到最后。
    // 这时候如果直接 return，就再也不会触发结尾处理：单曲循环不重复、列表也不切歌，
    // 听感上就是"一拖进度条，循环就失效了"。所以补一个很短的定时器收尾。
    const tail = setTimeout(() => {
      roomTimers.delete(roomId);
      store.apply(roomId, { type: "ended" });
      publish(roomId);
    }, 300);
    tail.unref?.();
    roomTimers.set(roomId, tail);
    return;
  }
  const timer = setTimeout(() => {
    roomTimers.delete(roomId);
    store.apply(roomId, { type: "ended" });
    publish(roomId);
  }, remaining * 1000 + 120);
  timer.unref?.();
  roomTimers.set(roomId, timer);
}

// ---------- 预置曲目 ----------
function preloadInto(roomId) {
  if (!PRELOAD) return;
  const src = path.resolve(PRELOAD);
  if (!fs.existsSync(src)) return console.warn(`[preload] 文件不存在：${src}`);
  if (store.get(roomId).playlist.length) return;

  const rawName = path.basename(src);
  if (!isAudio(rawName)) return console.warn(`[preload] 不支持的扩展名：${rawName}`);
  const id = uid(6);
  const ext = path.extname(rawName).toLowerCase();
  const dest = path.join(store.tracksDir(roomId), `${id}${ext}`);
  try {
    fs.copyFileSync(src, dest);
  } catch (err) {
    return console.warn(`[preload] 复制失败：${err.message}`);
  }
  const track = store.addTrack(roomId, {
    id,
    kind: "upload",
    title: rawName.replace(/\.[^.]+$/, ""),
    artist: "预置曲目",
    fileName: `${id}${ext}`,
    mime: sniffAudio(dest) || audioMimeFor(rawName),
    size: fs.statSync(dest).size,
    duration: 0,
  });
  store.apply(roomId, { type: "select", trackId: id });
  log(`[preload] 已为房间 ${roomId} 预置：${track.title}`);
}

// ---------- 路由 ----------
const baseUrlFor = (req) => {
  const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`.replace(/\/$/, "");
};

const bearer = (req, search) => {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  return m ? m[1].trim() : search?.get("token") || "";
};

function guard(req, res, roomId, token) {
  const auth = store.authorize(roomId, token);
  if (!auth.ok) {
    json(req, res, auth.code || 403, { error: auth.error });
    return null;
  }
  return auth.room;
}

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const regex = new RegExp("^" + pattern.replace(/:([A-Za-z]+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
  routes.push({ method, regex, keys, handler });
};

route("GET", "/api/health", (req, res) =>
  json(req, res, 200, { ok: true, version: "3.0.0", time: Date.now(), needsKey: Boolean(ADMIN_KEY) })
);

route("POST", "/api/report", async (req, res) => {
  let body = {};
  try {
    body = await readJson(req, 64 * 1024);
  } catch {}
  log("[前端上报] " + JSON.stringify(body));
  cors(req, res);
  res.writeHead(204);
  res.end();
});

route("POST", "/api/rooms/:room/claim", async (req, res, p) => {
  const body = await readJson(req);
  const result = store.claim(p.room, {
    clientId: String(body.clientId || ""),
    name: String(body.name || "GM"),
    token: String(body.token || ""),
    adminKey: String(body.adminKey || ""),
    requiredKey: ADMIN_KEY,
  });
  if (!result.ok) return json(req, res, result.code || 403, { error: result.error, owner: result.owner });
  if (result.fresh) preloadInto(p.room);
  publish(p.room);
  json(req, res, 200, result);
});

route("POST", "/api/rooms/:room/release", (req, res, p, search) => {
  if (!store.release(p.room, bearer(req, search))) return json(req, res, 403, { error: "令牌无效" });
  publish(p.room);
  json(req, res, 200, { ok: true });
});

route("POST", "/api/rooms/:room/heartbeat", (req, res, p, search) => {
  if (!guard(req, res, p.room, bearer(req, search))) return;
  json(req, res, 200, { ok: true });
});

route("GET", "/api/rooms/:room/now", (req, res, p) => json(req, res, 200, buildNow(store.get(p.room))));

/**
 * 长轮询：挂住请求，等状态变化再回包。
 * seq 已经不一样（客户端落后或领先）就立刻返回，否则最多等 timeout 毫秒。
 */
route("GET", "/api/rooms/:room/wait", (req, res, p, search) => {
  const room = store.get(p.room);
  const since = Number(search.get("since"));
  const timeout = Math.min(30000, Math.max(1000, Number(search.get("t")) || 25000));
  const gm = Boolean(search.get("token")) && store.authorize(p.room, search.get("token")).ok;

  const cur = room.playback.seq;
  if (!Number.isFinite(since) || cur !== since) {
    const payload = { seq: cur, now: buildNow(room) };
    if (gm) payload.state = buildState(room);
    return json(req, res, 200, payload);
  }

  const waiter = { req, res, gm, timer: null };
  if (!waiters.has(p.room)) waiters.set(p.room, new Set());
  waiters.get(p.room).add(waiter);

  const cleanup = () => {
    clearTimeout(waiter.timer);
    waiters.get(p.room)?.delete(waiter);
  };
  waiter.timer = setTimeout(() => {
    cleanup();
    // 超时就回当前状态，客户端会立刻再挂一个
    const payload = { seq: store.get(p.room).playback.seq, now: buildNow(store.get(p.room)), timeout: true };
    if (gm) payload.state = buildState(store.get(p.room));
    json(req, res, 200, payload);
  }, timeout);
  waiter.timer.unref?.();
  req.on("close", cleanup);
  res.on("close", cleanup);
});

route("GET", "/api/rooms/:room/state", (req, res, p, search) => {
  const room = guard(req, res, p.room, bearer(req, search));
  if (!room) return;
  json(req, res, 200, buildState(room));
});

route("GET", "/api/rooms/:room/events", (req, res, p, search) => {
  const gm = Boolean(search.get("token")) && store.authorize(p.room, search.get("token")).ok;
  cors(req, res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  // 顶开缓冲区：部分反向代理要攒够一定字节才愿意往下游吐数据，
  // 开头先灌一段注释无关痛痒，但能让 SSE 立刻开始流动。
  res.write(": " + " ".repeat(2048) + "\n\n");

  const client = { res, gm };
  if (!subs.has(p.room)) subs.set(p.room, new Set());
  subs.get(p.room).add(client);

  const room = store.get(p.room);
  if (gm) res.write(`event: state\ndata: ${JSON.stringify(buildState(room))}\n\n`);
  res.write(`event: now\ndata: ${JSON.stringify(buildNow(room))}\n\n`);

  const keepAlive = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(keepAlive);
    }
  }, 25000);
  const drop = () => {
    clearInterval(keepAlive);
    subs.get(p.room)?.delete(client);
  };
  req.on("close", drop);
  res.on("close", drop);
  res.on("error", drop);
});

route("POST", "/api/rooms/:room/command", async (req, res, p, search) => {
  const room = guard(req, res, p.room, bearer(req, search));
  if (!room) return;
  const body = await readJson(req);
  const result = store.apply(p.room, body);
  log(`  [指令] ${JSON.stringify(body).slice(0, 90)} -> ${result.ok ? "ok" : result.error}`);
  if (!result.ok) return json(req, res, 400, result);
  publish(p.room);
  json(req, res, 200, { ok: true, state: buildState(store.get(p.room)) });
});

// 上传本地音乐（原始字节流，避免 multipart）
route("POST", "/api/rooms/:room/tracks", (req, res, p, search) => {
  if (!guard(req, res, p.room, bearer(req, search))) return;

  const rawName = String(search.get("name") || "音频").slice(0, 160);
  if (!isAudio(rawName)) return json(req, res, 415, { error: "不支持的格式，请上传 mp3 / m4a / ogg / wav / flac" });
  const duration = Number(search.get("duration")) || 0;
  const ext = path.extname(rawName).toLowerCase();
  const id = uid(6);
  const fileName = `${id}${ext}`;
  const dest = path.join(store.tracksDir(p.room), fileName);
  const out = fs.createWriteStream(dest);

  let size = 0;
  let failed = false;
  const fail = (code, msg) => {
    if (failed) return;
    failed = true;
    out.destroy();
    fs.unlink(dest, () => {});
    json(req, res, code, { error: msg });
  };

  req.on("data", (c) => {
    if (failed) return;
    size += c.length;
    if (size > MAX_UPLOAD) fail(413, `文件超过 ${Math.round(MAX_UPLOAD / 1024 / 1024)}MB`);
  });
  out.on("error", () => fail(500, "写入磁盘失败"));
  req.pipe(out);

  out.on("finish", () => {
    if (failed) return;
    if (!size) return fail(400, "空文件");
    const track = store.addTrack(p.room, {
      id,
      kind: "upload",
      title: rawName.replace(/\.[^.]+$/, "").slice(0, 120),
      artist: "本地文件",
      fileName,
      mime: sniffAudio(dest) || audioMimeFor(rawName),
      size,
      duration,
      folder: cleanFolder(search.get("folder") || ""),
    });
    publish(p.room);
    json(req, res, 200, { ok: true, track });
  });
});

route("POST", "/api/rooms/:room/tracks/bilibili", async (req, res, p, search) => {
  if (!guard(req, res, p.room, bearer(req, search))) return;
  const { url, folder } = await readJson(req);
  if (!url) return json(req, res, 400, { error: "请提供 B 站链接" });
  try {
    const track = store.addTrack(p.room, { ...(await resolveBilibili(url)), folder: cleanFolder(folder || "") });
    publish(p.room);
    json(req, res, 200, { ok: true, track });
  } catch (err) {
    json(req, res, err.statusCode || 502, { error: err.message || "解析失败" });
  }
});

route("DELETE", "/api/rooms/:room/tracks/:id", (req, res, p, search) => {
  if (!guard(req, res, p.room, bearer(req, search))) return;
  if (!store.removeTrack(p.room, p.id)) return json(req, res, 404, { error: "曲目不存在" });
  publish(p.room);
  json(req, res, 200, { ok: true });
});

// 音频分发：玩家也要能取到当前曲目，所以不做鉴权（id 是随机串）
const audioHandler = async (req, res, p) => {
  const track = store.getTrack(p.room, p.id);
  if (!track) return json(req, res, 404, { error: "曲目不存在" });
  if (track.kind === "upload") {
    const abs = path.join(store.tracksDir(p.room), track.fileName || "");
    if (!serveFileRange(req, res, abs, track.mime)) json(req, res, 404, { error: "文件已丢失" });
    return;
  }
  return proxyRemote(req, res, p.room, track);
};
route("GET", "/audio/:room/:id", audioHandler);
route("HEAD", "/audio/:room/:id", audioHandler);

async function proxyRemote(req, res, roomId, track, retried = false) {
  if (track.kind === "bilibili" && (!track.srcUrl || (track.expiresAt && track.expiresAt - 60_000 < Date.now()))) {
    try {
      Object.assign(track, await refreshBilibili(track));
      store.save(roomId);
    } catch (err) {
      if (!track.srcUrl) return json(req, res, 502, { error: `B 站音轨失效：${err.message}` });
    }
  }

  const headers = { "Accept-Encoding": "identity" };
  Object.assign(headers, track.kind === "bilibili" ? BILI_HEADERS : { "User-Agent": BILI_HEADERS["User-Agent"] });
  if (req.headers.range) headers.Range = req.headers.range;

  let upstream;
  try {
    upstream = await fetch(track.srcUrl, { headers, redirect: "follow" });
  } catch (err) {
    return json(req, res, 502, { error: `上游音频不可用：${err.message}` });
  }

  if ([403, 470].includes(upstream.status) && track.kind === "bilibili" && !retried) {
    try {
      Object.assign(track, await refreshBilibili(track));
      store.save(roomId);
      return proxyRemote(req, res, roomId, track, true);
    } catch {}
  }
  if (upstream.status >= 400) return json(req, res, upstream.status, { error: `音频源返回 ${upstream.status}` });

  pipeUpstream(req, res, upstream, track.mime && track.mime !== "video/mp4" ? track.mime : "audio/mp4");
}

// ---------- 启动 ----------
function logRequest(req, res, pathname, t0) {
  const interesting =
    res.statusCode >= 400 ||
    pathname === "/" ||
    pathname === "/manifest.json" ||
    pathname.startsWith("/js/") ||
    pathname.startsWith("/api/") && !pathname.endsWith("/events");
  if (!interesting) return;
  const line = `${new Date().toLocaleTimeString("zh-CN", { hour12: false })}  ${req.method} ${pathname} -> ${res.statusCode} ${Date.now() - t0}ms`;
  // 默认只写日志文件，终端只留「安装地址 + 装法」；需要看实时请求用 --verbose
  if (VERBOSE) log(line);
  else logQuiet(line);
}

const server = http.createServer(async (req, res) => {
  const { pathname, search } = parseUrl(req);
  const t0 = Date.now();
  res.on("finish", () => logRequest(req, res, pathname, t0));

  if (req.method === "OPTIONS") {
    cors(req, res);
    res.writeHead(204);
    return res.end();
  }

  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]);
      });
      if (params.room) {
        params.room = cleanRoomId(params.room);
        if (!params.room) return json(req, res, 400, { error: "房间号无效" });
      }
      return await r.handler(req, res, params, search);
    }
    if ((req.method === "GET" || req.method === "HEAD") && serveStatic(req, res, pathname === "/" ? "/index.html" : pathname)) return;
    json(req, res, 404, { error: "Not found" });
  } catch (err) {
    logError("[server]", err);
    json(req, res, err.statusCode || 500, { error: err.message || "服务器错误" });
  }
});

/**
 * 启动时的恢复工作：
 *   1. 重新挂上自动切歌的定时器（否则重启时正在播的歌永远不会自动切下一首）
 *   2. 清掉歌单里已经不存在的音频文件（data/ 不能只增不减）
 * 只处理 JSON 能正常解析的房间；解析失败的一律跳过，绝不删文件。
 */
function restoreRooms() {
  let files = [];
  try {
    files = fs.readdirSync(store.roomsDir).filter((f) => f.endsWith(".json"));
  } catch {
    return { rooms: 0, resumed: 0, removed: 0 };
  }

  let resumed = 0;
  let removed = 0;
  const now = Date.now();

  for (const f of files) {
    const roomId = cleanRoomId(f.replace(/\.json$/, ""));
    if (!roomId || roomId !== f.replace(/\.json$/, "")) continue;

    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(store.roomsDir, f), "utf8").replace(/^\uFEFF/, ""));
    } catch {
      continue; // 存档坏了就跳过，不碰它的音频
    }

    // ---- 清理孤儿音频 ----
    try {
      const dir = store.tracksDir(roomId);
      const keep = new Set((raw.playlist || []).map((t) => t.fileName).filter(Boolean));
      for (const name of fs.readdirSync(dir)) {
        if (keep.has(name)) continue;
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        // 最近 10 分钟内动过的文件可能正在上传/预置，跳过
        if (now - st.mtimeMs < 10 * 60 * 1000) continue;
        fs.unlinkSync(p);
        removed += 1;
      }
    } catch {}

    // ---- 恢复自动切歌 ----
    const p = raw.playback;
    if (p?.playing && p?.trackId) {
      try {
        scheduleAutoAdvance(roomId);
        resumed += 1;
      } catch {}
    }
  }
  return { rooms: files.length, resumed, removed };
}

server.on("error", (err) => {
  // 端口被占用时不要让 Node 抛未处理的 error 事件（会打出一大段堆栈），
  // 给一句能看懂的提示后干净退出，由启动脚本负责收尾。
  if (err && err.code === "EADDRINUSE") {
    logError(`端口 ${PORT} 已被占用：可能是上一次的窗口还开着，或别的程序占用了它。`);
    log("  换个端口再试：在命令行里运行  点这个启动程序.bat --port 9000");
    process.exit(2);
  }
  logError(`服务启动失败：${err && err.message ? err.message : err}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  // 启动横幅默认不打印：真正要看的只有「安装地址」，由 setup 脚本负责显示。
  // 需要排查时用 --verbose 或 VERBOSE=1 打开这些细节。
  const r = restoreRooms();

  // 标题和分隔线始终保留，其它细节只在 --verbose 时打印
  log("");
  log("  咕咕点歌台 已启动");
  log("  --------------------------------------------------");

  if (VERBOSE) {
    const shown = HOST === "0.0.0.0" ? "localhost" : HOST;
    log(`  监听地址     : http://${shown}:${PORT}`);
    log(`  数据目录     : ${DATA_DIR}`);
    if (ADMIN_KEY) log("  主持密钥     : 已启用");
    if (PRELOAD) log(`  预置曲目     : ${PRELOAD}`);
    if (r.rooms) {
      log(`  恢复房间     : ${r.rooms} 个（${r.resumed} 个正在播放，已恢复自动切歌）`);
      if (r.removed) log(`  清理孤儿文件 : ${r.removed} 个`);
    }
    log("");
  } else if (r.removed) {
    // 清理属于异常情况，即使安静模式也要留一行
    log(`  已清理 ${r.removed} 个失效的音频文件`);
  }
  log("");
});

// 优雅退出：先关掉挂着的 SSE 与长轮询，客户端能立刻重连，不用等超时
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  for (const set of subs.values()) {
    for (const c of set) {
      try {
        c.res.end();
      } catch {}
    }
  }
  subs.clear();
  for (const set of waiters.values()) {
    for (const w of set) {
      try {
        clearTimeout(w.timer);
        w.res.end();
      } catch {}
    }
  }
  waiters.clear();
  for (const t of roomTimers.values()) {
    try {
      clearTimeout(t);
    } catch {}
  }
  roomTimers.clear();

  server.close(() => process.exit(0));
  const force = setTimeout(() => process.exit(0), 1500);
  force.unref?.();
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, shutdown);
