// 一键启动脚本：检查环境 → 起服务 →（可选）拉一条公网隧道 → 打印可粘贴的安装链接。
//
// 用法：
//   node scripts/setup.mjs              正常启动（有 cloudflared 就开隧道）
//   node scripts/setup.mjs --no-tunnel  只在本机/局域网跑
//   node scripts/setup.mjs --port 9000
import { spawn } from "node:child_process";
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
const PORT = Number(arg("port", process.env.PORT || 8787));
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
const children = [];
const server = spawn(process.execPath, [path.join(ROOT, "server/index.js"), "--port", String(PORT)], {
  cwd: ROOT,
  stdio: ["ignore", "inherit", "inherit"],
});
children.push(server);
let serverUp = false;
server.on("exit", (code) => {
  if (!serverUp) {
    say(c.red + `\n  服务启动失败（退出码 ${code}）。端口 ${PORT} 可能被占用，试试 --port 9000\n` + c.reset);
  }
  shutdown(0);
});

async function waitHealth(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(`http://localhost:${PORT}/api/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
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

box([
  `${c.bold}扩展安装地址${c.reset}`,
  "",
  `${c.cyan}${c.bold}${installUrl}${c.reset}`,
]);

say(`  ${c.bold}安装方法${c.reset}：左下角三个点 → Extension → 右上角加号 → 粘贴上面的地址`);
say("");
say(`  ${c.dim}提示：这个窗口要一直开着；关掉或重启后地址会变，你需要重新复制地址安装。${c.reset}`);
say("");
// ---------- 5. 退出清理 ----------
let closing = false;
function shutdown(code) {
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
