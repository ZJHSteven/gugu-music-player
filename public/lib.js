// 公共服务层：本地存储、访问服务端、浮窗↔引擎总线、OBR SDK 加载与身份识别。

// ---------- 存储（沙箱里 localStorage 会抛错，包一层） ----------
const mem = new Map();

export function lsGet(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    if (v !== null) return v;
  } catch {}
  return mem.has(key) ? mem.get(key) : fallback;
}

export function lsSet(key, value) {
  mem.set(key, String(value));
  try {
    localStorage.setItem(key, String(value));
  } catch {}
}

export function lsDel(key) {
  mem.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {}
}

// ---------- 服务端 ----------
// 优先级：config.js 里写死的 > 链接参数 ?api= > 本地记住的 > 同源
const PARAM_API = new URLSearchParams(location.search).get("api");
const CONFIG_API = typeof window !== "undefined" && window.BARD_API ? String(window.BARD_API) : "";

/** OBR 解析相对路径时会拼出 "host./" 这种带结尾点的地址，这里规范化掉。 */
function normalizeOrigin(raw) {
  try {
    const u = new URL(raw);
    if (u.hostname.endsWith(".")) u.hostname = u.hostname.slice(0, -1);
    return u.origin;
  } catch {
    return String(raw);
  }
}

export function apiBase() {
  const raw = CONFIG_API || PARAM_API || lsGet("bard:api") || location.origin;
  return normalizeOrigin(raw).replace(/\/+$/, "");
}

// 每次加载生成一个客户端标识，上报时带上，方便区分是 GM 还是某个玩家
const CLIENT_TAG = (() => {
  try {
    return crypto.randomUUID().slice(0, 8);
  } catch {
    return Math.random().toString(16).slice(2, 10);
  }
})();

export const tokenKey = (roomId) => `bard:token:${roomId}`;

async function parse(res) {
  const raw = await res.text();
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = { error: raw.slice(0, 200) };
  }
  if (!res.ok) {
    const err = new Error(body?.error || `请求失败 (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export async function apiGet(path, token) {
  // 云版前端的房间控制完全由 Owlbear 房间元数据承担，不访问 Node API。
  // 延迟初始化时仅允许 /api/update 读取空状态；其余必须先拿到云 Bridge。
  if (window.BARD_CLOUD) {
    if (path === "/api/update") return { current: "云端版", hasUpdate: false };
    if (!window.__cloudBridge) throw new Error("云端房间尚未初始化");
    return window.__cloudBridge.apiGet(path);
  }
  return parse(
    await fetch(apiBase() + path, { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: "no-store" })
  );
}

export async function apiPost(path, body, token) {
  if (window.BARD_CLOUD) {
    if (!window.__cloudBridge) throw new Error("云端房间尚未初始化");
    return window.__cloudBridge.apiPost(path, body);
  }
  return parse(
    await fetch(apiBase() + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body || {}),
    })
  );
}

/** 上传音频（XHR 才有上传进度）。 */
export function uploadTrack({ roomId, token, file, duration, folder, onProgress }) {
  if (window.BARD_CLOUD) {
    if (!window.__cloudBridge) return Promise.reject(new Error("云端房间尚未初始化"));
    return window.__cloudBridge.uploadTrack({ file, duration, folder, onProgress });
  }
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({
      name: file.name || "音频",
      duration: String(Math.round(Number(duration) || 0)),
      folder: folder || "",
    });
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${apiBase()}/api/rooms/${encodeURIComponent(roomId)}/tracks?${qs}`);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        return reject(new Error("服务器返回异常"));
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body?.error || `上传失败 (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("网络错误"));
    xhr.send(file);
  });
}

/** 上传前读时长：进度条和自动切歌都靠它。 */
export function mediaDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const done = (v) => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(v) && v > 0 ? v : 0);
    };
    audio.preload = "metadata";
    audio.onloadedmetadata = () => done(audio.duration);
    audio.onerror = () => done(0);
    setTimeout(() => done(0), 6000);
    audio.src = url;
  });
}

/** 现场诊断：扩展在 OBR 里起不来时，服务端日志是唯一线索。 */
export function report(kind, detail) {
  // 云版无 Node /api/report：不能持续发送诊断请求导致额度损耗。
  if (window.BARD_CLOUD) return;
  try {
    fetch(`${apiBase()}/api/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, detail, client: CLIENT_TAG, href: location.href, at: Date.now() }),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

// ---------- 浮窗 ↔ 引擎 总线 ----------
// BroadcastChannel 同源广播，同浏览器多标签页会互相干扰，用 sessionStorage 做标签页隔离。
const CHANNEL = "bard-bus";
let tabCache = null;

export function tabId() {
  if (tabCache !== null) return tabCache;
  try {
    let id = sessionStorage.getItem("bard:tab");
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      sessionStorage.setItem("bard:tab", id);
    }
    tabCache = id;
  } catch {
    tabCache = "";
  }
  return tabCache;
}

export function createBus({ onMessage }) {
  let bc = null;
  const me = tabId();
  try {
    bc = new BroadcastChannel(CHANNEL);
    bc.onmessage = (ev) => {
      const msg = ev.data;
      if (!msg || typeof msg !== "object") return;
      if (me && msg.__tab && msg.__tab !== me) return;
      onMessage(msg);
    };
  } catch {
    bc = null;
  }
  return {
    post(msg) {
      try {
        bc?.postMessage({ ...msg, __tab: me });
      } catch {}
    },
    close() {
      try {
        bc?.close();
      } catch {}
    },
  };
}

// ---------- OBR SDK ----------
import { validateOwlbearIdentity } from "./obr-identity.js";
let sdkPromise = null;

/**
 * 把页面早期缓存下来的父窗口消息回放给 SDK。
 * OBR 在 iframe 加载时就发一次 OBR_READY，而 SDK 要等模块（含依赖）加载完才挂监听，
 * 那条消息会丢 —— 表现就是 isReady 永远 false、getRole() 一直报 not ready。
 */
function replayParentMessages() {
  const buf = window.__bardMessages;
  if (!Array.isArray(buf) || !buf.length) return;
  window.__bardMessages = [];
  for (const m of buf) {
    try {
      window.dispatchEvent(new MessageEvent("message", { data: m.data, origin: m.origin }));
    } catch {}
  }
}

async function loadSdk() {
  const mod = await import("./sdk/obr.js");
  replayParentMessages();
  return mod.default;
}

/** 等 SDK 真正就绪（OBR 用 postMessage 握手，往往比脚本加载慢）。 */
async function waitReady(OBR, timeout = 12000) {
  if (OBR?.isReady) return true;
  const t0 = Date.now();
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    try {
      OBR.onReady(finish);
    } catch {
      finish();
    }
    const timer = setInterval(() => {
      if (OBR?.isReady || Date.now() - t0 > timeout) {
        clearInterval(timer);
        finish();
      }
    }, 150);
  });
  return Boolean(OBR?.isReady);
}

/**
 * 取角色。SDK 未就绪时 getRole() 会直接抛错，
 * 一次失败就当成玩家会把真 GM 判成玩家，所以必须重试。
 */
async function detectRole(OBR, tries = 8, gap = 500) {
  const attempts = [];
  for (let i = 0; i < tries; i++) {
    try {
      const role = await OBR.player.getRole();
      attempts.push({ ok: true, role });
      if (role === "GM" || role === "PLAYER") return { role, attempts };
    } catch (err) {
      attempts.push({ ok: false, err: String(err?.message || err) });
    }
    await new Promise((r) => setTimeout(r, gap));
  }
  // SDK 尚未返回角色不能擅自判成 PLAYER，否则后续空会话被伪装成没有歌。
  return { role: null, attempts };
}

/** 返回 { OBR, ready, role, attempts, roomId, name }。?dev=1 用假 SDK。 */
export async function initOBR() {
  if (!sdkPromise) {
    const dev = new URLSearchParams(location.search).get("dev");
    sdkPromise = dev ? import("./dev-sdk.js").then((m) => ({ dev: true, OBR: m.default })) : loadSdk().then((OBR) => ({ dev: false, OBR }));
  }
  let sdk;
  try { sdk = await sdkPromise; }
  catch (error) {
    // 模块或握手出现一次性异常时，允许重新加载页面后重新尝试。
    sdkPromise = null;
    throw error;
  }
  const { OBR, dev } = sdk;
  const ready = await waitReady(OBR);
  // Owlbear 官方明确要求 SDK ready 后才能使用房间、角色等接口。
  // 不能等 12 秒后继续执行：梅林旧报告恰好是 PLAYER+空房间状态。
  if (!ready) {
    report("identity-unavailable", { code: "SDK_NOT_READY", dev });
    validateOwlbearIdentity({ ready, role: null, roomId: "" });
  }
  const { role, attempts } = await detectRole(OBR);
  const roomId = OBR.room?.id || "";
  try {
    validateOwlbearIdentity({ ready, role, roomId });
  } catch (error) {
    // 诊断仅记录固定错误代码与是否有房间 ID，不发送真实房间号。
    report("identity-unavailable", {
      code: error.code, dev, attempts: attempts.length, roomIdPresent: Boolean(roomId),
    });
    throw error;
  }
  const name = await OBR.player.getName().catch(() => "");
  report("identity", { dev, ready, role, roomIdPresent: true, attempts });
  return { OBR, ready, role, attempts, roomId, name };
}
