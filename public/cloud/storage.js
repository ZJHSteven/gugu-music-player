/**
 * 浏览器本地歌曲库。
 *
 * OPFS (Origin Private File System) 是浏览器按网站 Origin 隔离的私人文件系统，
 * 不是 HTTP Cache。它适合放二进制音频，但仍受浏览器配额与自动驱逐策略约束。
 * 某些 WebKit/隐私模式环境不支持 OPFS 时，回退到 IndexedDB 的 Blob。
 * 两者都不可写时，仅为本次 iframe 生命周期提供有上限的内存兜底：
 * 这能让无痕模式的玩家至少听到当前歌曲，但刷新后音频副本会消失，
 * 绝不能把它当作 GM 的长期备份或浏览器永久缓存。
 *
 * 文件以 SHA-256 为文件名，避免不同玩家导入的重名曲目覆盖彼此。
 */
const DB_NAME = "gugu-cloud-audio-v1";
const STORE = "tracks";
const encoder = (hash) => /^[0-9a-f]{64}$/.test(hash || "");
// 最大临时内存预算 96 MiB，单曲上限仍由中继的 64 MiB 校验负责。
// Map 的顺序即 LRU：访问时将文件移到末尾；超限时驱逐最旧音频。
const MEMORY_LIMIT = 96 * 1024 * 1024;
const sessionMemory = new Map();
let memoryBytes = 0;

function getSessionFile(hash) {
  const file = sessionMemory.get(hash);
  if (!file) return null;
  sessionMemory.delete(hash);
  sessionMemory.set(hash, file);
  return file;
}

function putSessionFile(hash, blob) {
  if (blob.size > MEMORY_LIMIT) throw new Error("会话内存缓存上限不足");
  const previous = sessionMemory.get(hash);
  if (previous) {
    memoryBytes -= previous.size;
    sessionMemory.delete(hash);
  }
  while (memoryBytes + blob.size > MEMORY_LIMIT && sessionMemory.size) {
    const oldestHash = sessionMemory.keys().next().value;
    memoryBytes -= sessionMemory.get(oldestHash).size;
    sessionMemory.delete(oldestHash);
  }
  sessionMemory.set(hash, blob);
  memoryBytes += blob.size;
}

function dbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(hash) {
  const db = await dbOpen();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, "readonly");
      const req = t.objectStore(STORE).get(hash);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}

async function idbPut(hash, blob) {
  const db = await dbOpen();
  try {
    await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, "readwrite");
      t.objectStore(STORE).put(blob, hash);
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally { db.close(); }
}

async function opfsRoot() {
  if (typeof navigator?.storage?.getDirectory !== "function") throw new Error("OPFS 不可用");
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("gugu-cloud", { create: true });
}

export async function digest(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, "0")).join("");
}

export async function getAudio(hash) {
  if (!encoder(hash)) return null;
  // 临时副本对当前 iframe 可立即读取，但绝不向其他 iframe 虚报拥有它。
  const temporary = getSessionFile(hash);
  if (temporary) return temporary;
  try {
    const root = await opfsRoot();
    const handle = await root.getFileHandle(hash);
    return await handle.getFile();
  } catch {
    return idbGet(hash).catch(() => null);
  }
}

export async function putAudio(hash, blob) {
  if (!encoder(hash)) throw new Error("音频摘要格式不正确");
  if ((await digest(blob)) !== hash) throw new Error("音频 SHA-256 校验失败");
  try {
    const root = await opfsRoot();
    const handle = await root.getFileHandle(hash, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(blob);
      await writable.close();
    } catch (e) {
      await writable.abort().catch(() => {});
      throw e;
    }
    return "opfs";
  } catch {
    try {
      await idbPut(hash, blob);
      return "indexeddb";
    } catch {
      // WebKit 隐私模式和第三方 iframe 可能同时禁止两种磁盘存储。
      // 内容已经通过 SHA-256 核验，暂存在本页面内存可以继续播放；
      // 关闭面板/刷新页面时就会丢失，绝不把此结果显示为持久备份。
      putSessionFile(hash, blob);
      return "memory";
    }
  }
}

/**
 * Chrome/Firefox/Safari 都可尝试申请持久化，但浏览器可拒绝；
 * 用户删除网站数据、设备空间极低或系统清理时仍可能丢失。
 */
export async function requestPersistence() {
  try {
    if (typeof navigator?.storage?.persist !== "function") return false;
    return Boolean(await navigator.storage.persist());
  } catch { return false; }
}
