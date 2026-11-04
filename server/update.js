// 自动更新：检查 GitHub Releases、下载新版、下次启动时替换文件。
//
// 为什么不在运行中直接覆盖：Windows 不允许替换正在运行的 exe，
// 而且半途替换容易留下坏文件。所以下载到 .update/pending，
// 由启动脚本在下一次启动、服务还没起来的时候一次性替换。
import fs from "node:fs";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "doveris263/gugu-music-player";
const UPDATE_DIR = path.join(ROOT, ".update");
const PENDING = path.join(UPDATE_DIR, "pending");
const STATE_FILE = path.join(UPDATE_DIR, "state.json");

// 这些目录可以安全替换（不含正在运行的 exe）
const SWAPPABLE = ["public", "server", "scripts", "img"];

export function currentVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function cmp(a, b) {
  const pa = String(a).replace(/^v/, "").split(".").map(Number);
  const pb = String(b).replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { autoUpdate: true, lastCheck: 0, latest: "", url: "", notes: "" };
  }
}

function writeState(patch) {
  const next = { ...readState(), ...patch };
  try {
    fs.mkdirSync(UPDATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), "utf8");
  } catch {}
  return next;
}

export function setAutoUpdate(enabled) {
  writeState({ autoUpdate: Boolean(enabled) });
  return Boolean(enabled);
}

export function getUpdateState() {  const st = readState();
  return {
    current: currentVersion(),
    latest: st.latest || "",
    hasUpdate: Boolean(st.latest && cmp(st.latest, currentVersion()) > 0),
    autoUpdate: st.autoUpdate !== false,
    lastCheck: st.lastCheck || 0,
    notes: st.notes || "",
    ready: Boolean(st.ready && st.readyVersion && cmp(st.readyVersion, currentVersion()) > 0),
    readyVersion: st.ready && st.readyVersion ? st.readyVersion : "",
    url: st.url || "",
    pending: fs.existsSync(PENDING),
  };
}

/** 查一次 GitHub 最新版本。失败不抛，返回错误信息。 */
export async function checkForUpdate() {
  const headers = { "User-Agent": "gugu-music-player", Accept: "application/vnd.github+json" };
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers });
    if (!r.ok) return { ok: false, error: `GitHub 返回 ${r.status}` };
    const j = await r.json();
    const tag = String(j.tag_name || "").trim();
    const asset = (j.assets || []).find((a) => /\.zip$/i.test(a.name));
    writeState({ latest: tag, url: asset?.browser_download_url || "", notes: (j.body || "").slice(0, 2000), lastCheck: Date.now() });
    const state = getUpdateState();
    return { ok: true, ...state };
  } catch (err) {
    writeState({ lastCheck: Date.now() });
    return { ok: false, error: String(err.message || err) };
  }
}

/** 下载新版并解压到 .update/pending，等下次启动应用。 */
export async function downloadUpdate(onLog = () => {}) {
  const st = getUpdateState();
  if (!st.hasUpdate) return { ok: false, error: "已经是最新版本" };
  const url = readState().url;
  if (!url) return { ok: false, error: "没有找到下载地址" };

  fs.mkdirSync(UPDATE_DIR, { recursive: true });
  const zipPath = path.join(UPDATE_DIR, `v${st.latest}.zip`);
  onLog(`下载 ${url}`);
  const res = await fetch(url, { headers: { "User-Agent": "gugu-music-player" } });
  if (!res.ok) return { ok: false, error: `下载失败 ${res.status}` };
  await pipeline(res.body, createWriteStream(zipPath));

  // 解压（用系统自带 tar，Windows 10+ 都有）
  fs.rmSync(PENDING, { recursive: true, force: true });
  fs.mkdirSync(PENDING, { recursive: true });
  const { spawnSync } = await import("node:child_process");
  const un = spawnSync("tar", ["-xf", zipPath, "-C", PENDING], { timeout: 120000 });
  if (un.status !== 0) return { ok: false, error: "解压失败：" + String(un.stderr || "").slice(0, 200) };

  // 压缩包里通常多一层目录
  const entries = fs.readdirSync(PENDING, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (entries.length === 1 && fs.existsSync(path.join(PENDING, entries[0].name, "package.json"))) {
    const inner = path.join(PENDING, entries[0].name);
    for (const f of fs.readdirSync(inner)) {
      fs.renameSync(path.join(inner, f), path.join(PENDING, f));
    }
    fs.rmSync(inner, { recursive: true, force: true });
  }
  writeState({ ready: true, readyVersion: st.latest });
  onLog("解压完成，关闭窗口后重新启动即可完成更新");
  return { ok: true, version: st.latest, ready: true };
}

/**
 * 启动时调用：把 pending 里的新版覆盖到程序目录。
 * 只替换 public/server/scripts/img，不动 runtime 里的 exe 和 data/。
 */
export function applyPendingUpdate() {
  if (!fs.existsSync(PENDING)) return { applied: false };
  const versionFile = path.join(PENDING, "package.json");
  if (!fs.existsSync(versionFile)) {
    fs.rmSync(PENDING, { recursive: true, force: true });
    return { applied: false, reason: "pending 不完整" };
  }
  const nextVersion = (() => {
    try {
      return JSON.parse(fs.readFileSync(versionFile, "utf8")).version || "";
    } catch {
      return "";
    }
  })();
  const backup = path.join(UPDATE_DIR, "backup-" + currentVersion());
  fs.mkdirSync(backup, { recursive: true });
  for (const dir of SWAPPABLE) {
    const src = path.join(PENDING, dir);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(ROOT, dir);
    try {
      if (fs.existsSync(dst)) fs.cpSync(dst, path.join(backup, dir), { recursive: true });
      fs.rmSync(dst, { recursive: true, force: true });
      fs.cpSync(src, dst, { recursive: true });
    } catch (err) {
      return { applied: false, reason: String(err.message || err) };
    }
  }
  // 根目录的文档也更新
  for (const f of ["README.md", "README.txt", "一定要先看README！.txt", "LICENSE", "package.json"]) {
    const src = path.join(PENDING, f);
    if (fs.existsSync(src)) {
      try {
        fs.copyFileSync(src, path.join(ROOT, f));
      } catch {}
    }
  }
  fs.rmSync(PENDING, { recursive: true, force: true });
  writeState({ ready: false, readyVersion: "" });
  return { applied: true, version: nextVersion };
}
