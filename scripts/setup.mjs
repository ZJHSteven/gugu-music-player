// 一键启动脚本：检查环境 → 起服务 →（可选）拉一条公网隧道 → 打印可粘贴的安装链接。
//
// 用法：
//   node scripts/setup.mjs              正常启动（有 cloudflared 就开隧道）
//   node scripts/setup.mjs --no-tunnel  只在本机/局域网跑
//   node scripts/setup.mjs --port 9000
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN_DIR = path.join(ROOT, ".bin");
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PREFERRED_PORT = Number(arg("port", process.env.PORT || 8787));
let PORT = PREFERRED_PORT;
const WANT_TUNNEL = !argv.includes("--no-tunnel");

const c = {
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
};
const say = (...a) => console.log(...a);

function box(lines) {
  const width = Math.max(...lines.map((l) => displayWidth(l))) + 2;
  say("");
  say(c.green + "  ┌" + "─".repeat(width) + "┐" + c.reset);
  for (const l of lines) {
    const pad = " ".repeat(Math.max(0, width - displayWidth(l)));
    say(c.green + "  │ " + c.reset + l + pad + c.green + " │" + c.reset);
  }
  say(c.green + "  └" + "─".repeat(width) + "┘" + c.reset);
  say("");
}
// 把地址直接放进剪贴板：省掉「选中 → 复制」这一步，也就不带空格了
function copyToClipboard(text) {
  try {
    const p = os.platform();
    const cmd = p === "win32" ? "clip" : p === "darwin" ? "pbcopy" : "xclip";
    const args = p === "linux" ? ["-selection", "clipboard"] : [];
    const cp = spawnSync(cmd, args, { input: text, timeout: 3000 });
    return cp.status === 0;
  } catch {
    return false;
  }
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
// 终端里汉字/全角符号占两格，按显示宽度算才不会把边框撑歪
function displayWidth(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const code = ch.codePointAt(0);
    w += code >= 0x1100 && (
      code <= 0x115f ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f)
    ) ? 2 : 1;
  }
  return w;
}

// ---------- 0. 应用上次下载的更新 ----------
// 必须在起服务之前替换 public/server/scripts，新代码才会被加载。
try {
  const { applyPendingUpdate } = await import("../server/update.js");
  const applied = applyPendingUpdate();
  if (applied.applied) say(c.green + `  已更新到 v${applied.version}` + c.reset);
} catch {}

// ---------- 1. 环境检查 ----------
const major = Number(process.versions.node.split(".")[0]);
if (major < 18) {
  say(c.red + `\n  Node.js 版本太低（当前 ${process.version}），需要 18 或更高。` + c.reset);
  say(`  请到 https://nodejs.org 装一个 LTS 版本再来。\n`);
  process.exit(1);
}
say(c.dim + `  Node ${process.version} · ${os.platform()} ${os.arch()}` + c.reset);

for (const needed of ["server/index.js", "public/manifest.json"]) {
  if (!fs.existsSync(path.join(ROOT, needed))) {
    say(c.red + `\n  缺少文件：${needed}\n  请在完整的项目目录里运行这个脚本。\n` + c.reset);
    process.exit(1);
  }
}

// ---------- 2. 起服务 ----------
// 清理逻辑必须先声明：子进程可能在下面任何 await 之前就退出（例如端口被占用），
// 那时如果 shutdown 还没定义、closing 还在 TDZ，就会抛 ReferenceError 盖住真正的错误。
const children = [];
let closing = false;
function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  for (const ch of children) {
    try {
      ch.kill();
    } catch {}
  }
  setTimeout(() => process.exit(code), 300);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("uncaughtException", (err) => {
  say(c.red + `\n  出错了：${err && err.message ? err.message : err}\n` + c.reset);
  shutdown(1);
});

// 端口三态探测：
//   ours —— 同一端口上已经有「我们这个插件」在跑（最常见：上次的窗口没关）
//   busy —— 被别的程序占用
//   free —— 可用
async function probePort(port, timeoutMs = 1200) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/manifest.json`, { signal: ctl.signal });
    if (!res.ok) return "busy";
    const m = await res.json().catch(() => null);
    return m && typeof m.name === "string" && m.name.includes("咕咕点歌台") ? "ours" : "busy";
  } catch {
    return "free";
  } finally {
    clearTimeout(timer);
  }
}

async function pickPort(start) {
  for (let p = start; p < start + 20; p += 1) {
    const state = await probePort(p);
    if (state === "free") return { port: p, state };
    if (state === "ours") return { port: p, state };
  }
  return { port: start, state: "busy" };
}

// 上次成功启动时记录的地址（用来告诉用户"已经在跑的是哪个地址"）
function lastKnownUrl() {
  try {
    const v = fs.readFileSync(path.join(BIN_DIR, "last-url.txt"), "utf8").trim();
    return /^https?:\/\//.test(v) ? v : "";
  } catch {
    return "";
  }
}

{
  const state = await probePort(PREFERRED_PORT);
  if (state === "ours") {
    const known = lastKnownUrl();
    say("");
    say(`  ${c.yellow}已经有一个咕咕点歌台在运行了${c.reset}（端口 ${PREFERRED_PORT}）。`);
    say(`  ${c.bold}直接切回那个窗口就能看到安装地址${c.reset}，不用再开第二个。`);
    if (known) {
      say("");
      say(`  上次的地址：${c.cyan}${known}${c.reset}`);
      say(`  ${c.dim}（如果那个窗口重启过，地址会变，以窗口里显示的为准）${c.reset}`);
    }
    say("");
    process.exit(0);
  }
  if (state === "busy") {
    const picked = await pickPort(PREFERRED_PORT + 1);
    if (picked.state === "free") {
      say(`  ${c.dim}端口 ${PREFERRED_PORT} 被别的程序占用，改用 ${picked.port}${c.reset}`);
      PORT = picked.port;
    } else if (picked.state === "ours") {
      say("");
      say(`  ${c.yellow}咕咕点歌台正在 ${picked.port} 端口上运行${c.reset}，直接切回那个窗口即可。`);
      say("");
      process.exit(0);
    } else {
      say("");
      say(`  ${c.red}端口被占用，且 ${PREFERRED_PORT} 起的 20 个端口都不可用。${c.reset}`);
      say(`  ${c.dim}关掉别的程序后重试，或手动指定：点这个启动程序.bat --port 9000${c.reset}`);
      say("");
      process.exit(1);
    }
  }
}

const server = spawn(process.execPath, [path.join(ROOT, "server/index.js"), "--port", String(PORT)], {
  cwd: ROOT,
  stdio: ["ignore", "inherit", "inherit"],
});
children.push(server);
let serverUp = false;
server.on("exit", (code) => {
  if (!serverUp) {
    // 退出码 2 = 服务端已经解释过端口冲突，这里只补一句怎么办，避免同样的字重复两遍
    if (code === 2) {
      say(c.dim + `  也可以先关掉占用 ${PORT} 的那个窗口（比如之前开着的本插件终端）。\n` + c.reset);
    } else {
      say(c.red + `\n  服务启动失败（退出码 ${code}）。\n` + c.reset);
      say(c.dim + `  换个端口再试：点这个启动程序.bat --port 9000\n` + c.reset);
    }
    shutdown(1);
    return;
  }
  say(c.dim + "\n  服务已退出，正在关闭…\n" + c.reset);
  shutdown(0);
});

// 判断"是不是我这次起的服务在响应"。
// 端口冲突时子进程会在 100ms 内退出，而旧实例可能仍然在同一个端口上正常响应，
// 所以先等一个稳定期，再要求连续两次健康检查都通过、且子进程还活着。
async function waitHealth(timeoutMs = 15000) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(700);
  if (server.exitCode !== null) return false;
  const started = Date.now();
  let streak = 0;
  while (Date.now() - started < timeoutMs) {
    if (server.exitCode !== null) return false;
    try {
      const r = await fetch(`http://localhost:${PORT}/api/health`);
      streak = r.ok ? streak + 1 : 0;
      if (streak >= 2) return true;
    } catch {
      streak = 0;
    }
    await sleep(350);
  }
  return false;
}

if (!(await waitHealth())) {
  say(c.red + "\n  服务没有响应，请检查上面的报错。\n" + c.reset);
  shutdown(1);
}
serverUp = true;

// ---------- 3. 可选：公网隧道 ----------
let publicUrl = "";

const cfName = os.platform() === "win32" ? "cloudflared.exe" : "cloudflared";
// 随包自带的优先（放在 runtime/ 里，和 node.exe 一起）；其次是以前下载过的 .bin/
const cfBundled = path.join(ROOT, "runtime", cfName);
const cfDownloaded = path.join(BIN_DIR, cfName);
const cfPath = fs.existsSync(cfBundled) ? cfBundled : cfDownloaded;

function cfAsset() {
  const p = os.platform();
  if (p === "win32") return { url: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe", file: cfName, tgz: false };
  if (p === "darwin") return { url: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz", file: "cloudflared.tar.gz", tgz: true };
  return { url: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64", file: cfName, tgz: false };
}

async function ensureCloudflared() {
  if (fs.existsSync(cfPath) && fs.statSync(cfPath).size > 1024 * 1024) return true;
  const asset = cfAsset();
  say(c.dim + `  首次运行：下载 cloudflared（约 50MB，只需一次）…` + c.reset);
  try {
    const res = await fetch(asset.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const tmp = path.join(BIN_DIR, asset.file);
    fs.writeFileSync(tmp, buf);
    if (asset.tgz) {
      const { execFileSync } = await import("node:child_process");
      execFileSync("tar", ["-xzf", tmp, "-C", BIN_DIR]);
      fs.unlinkSync(tmp);
      fs.chmodSync(cfPath, 0o755);
    } else {
      fs.renameSync(tmp, cfPath);
      if (os.platform() !== "win32") fs.chmodSync(cfPath, 0o755);
    }
    return true;
  } catch (err) {
    say(c.yellow + `  自动下载失败（${err.message}）。` + c.reset);
    say(c.dim + `  国内网络常常连不上 GitHub，可以手动下载后放到这个位置：` + c.reset);
    say(c.dim + `    ${asset.url}` + c.reset);
    say(c.dim + `    ${cfDownloaded}` + c.reset);
    say(c.yellow + `  本次先以「本机模式」运行——只有这台电脑能访问。` + c.reset);
    return false;
  }
}

async function startTunnel() {
  if (!(await ensureCloudflared())) return "";
  say(c.dim + "  正在建立公网隧道…" + c.reset);

  const tunnel = spawn(cfPath, ["tunnel", "--url", `http://localhost:${PORT}`, "--no-autoupdate"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(tunnel);

  return new Promise((resolve) => {
    let settled = false;
    const onData = (chunk) => {
      const text = chunk.toString();
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text);
      if (m && !settled) {
        settled = true;
        resolve(m[0]);
      }
    };
    tunnel.stdout.on("data", onData);
    tunnel.stderr.on("data", onData);
    setTimeout(() => {
      if (!settled) resolve("");
    }, 25000);
    tunnel.on("exit", () => {
      if (!settled) resolve("");
    });
  });
}

if (WANT_TUNNEL) {
  publicUrl = await startTunnel();
}

// ---------- 4. 结果 ----------
const localBase = `http://localhost:${PORT}`;
const installUrl = (publicUrl || localBase) + "/manifest.json";

try {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.writeFileSync(path.join(BIN_DIR, "last-url.txt"), installUrl + "\n", "utf8");
} catch {}

const copied = copyToClipboard(installUrl);

say("");
say(`  ${c.bold}扩展安装地址${c.reset}` + (copied ? `  ${c.green}（已自动复制到剪贴板）${c.reset}` : ""));
say("");
// 这一行只有地址本身：无缩进、无边框、无尾部补空格。
// 三击即可整行选中，复制出来不会带上空格。
say(`${c.cyan}${c.bold}${installUrl}${c.reset}`);
say("");
say(`  ${c.bold}安装方法${c.reset}：左下角三个点 → Extension → 右上角加号 → 粘贴`);
say(`  ${c.dim}（地址已复制，直接粘贴即可；没复制成功就三击上面那行地址）${c.reset}`);
say("");
say(`  ${c.dim}提示：这个窗口要一直开着；关掉或重启后地址会变，需要重新安装一次。${c.reset}`);
say("");

// ---------- 5. 后台检查更新（不阻塞启动） ----------
try {
  const { checkForUpdate, downloadUpdate, getUpdateState, currentVersion } = await import("../server/update.js");
  const cur = currentVersion();
  say(`  ${c.dim}当前版本 v${cur}${c.reset}`);
  const st = getUpdateState();
  if (st.autoUpdate) {
    checkForUpdate()
      .then(async (r) => {
        if (!r.ok) {
          say(`  ${c.dim}检查更新失败（${r.error || "网络不通"}），不影响使用${c.reset}`);
          return;
        }
        if (!r.hasUpdate) {
          say(`  ${c.dim}已是最新版本${c.reset}`);
          return;
        }
        say(`  ${c.green}发现新版本 ${r.latest}${c.reset}，正在后台下载…`);
        const d = await downloadUpdate((m) => say(`  ${c.dim}${m}${c.reset}`));
        if (d.ok) {
          say("");
          say(`  ${c.green}${c.bold}新版本 ${r.latest} 已下载完成${c.reset}`);
          say(`  ${c.bold}请关闭这个窗口，再双击「点这个启动程序」${c.reset}`);
          say(`  ${c.dim}重新启动后就是新版本，歌单和设置都会保留。${c.reset}`);
          say("");
        } else {
          say(`  ${c.yellow}自动下载失败${c.reset}：${d.error}`);
        }
      })
      .catch(() => {});
  } else {
    say(`  ${c.dim}自动更新已关闭${c.reset}`);
  }
} catch {}

