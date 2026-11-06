/**
 * 咕咕点歌台 Electron 启动器。
 *
 * 这个文件故意不重写原来的 server/index.js：
 * - Electron 本身已经捆绑 Node.js；
 * - 主进程通过 child_process.fork() 启动原服务端；
 * - cloudflared 作为原生二进制放在 app 的 Resources 目录；
 * - 用户只需要双击应用，不需要 Node.js、终端或任何命令。
 *
 * 这样做最大的优点是风险小：原来已经跑通的 Owlbear、SSE、音频 Range、
 * B 站代理和房间同步逻辑都不动，Electron 只负责“把启动步骤藏起来”。
 */
import { app, BrowserWindow, clipboard, ipcMain, shell } from "electron";
import { fork, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const IS_SMOKE_TEST = process.argv.includes("--smoke-test");
const DEFAULT_PORT = 8787;
const TUNNEL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

let mainWindow = null;
let serverProcess = null;
let tunnelProcess = null;
let quitting = false;

/**
 * renderer 只读取这一份状态。
 * logs 只保留最近 120 行，避免 cloudflared 长时间运行后把 renderer 消息撑得过大。
 */
const runtime = {
  phase: "idle",
  message: "准备启动",
  port: null,
  localBase: "",
  publicBase: "",
  installUrl: "",
  logs: [],
};

function snapshot() {
  return {
    phase: runtime.phase,
    message: runtime.message,
    port: runtime.port,
    localBase: runtime.localBase,
    publicBase: runtime.publicBase,
    installUrl: runtime.installUrl,
    logs: runtime.logs.slice(-120),
  };
}

function publish() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("runtime:state", snapshot());
}

function setPhase(phase, message) {
  runtime.phase = phase;
  runtime.message = message;
  publish();
}

function addLog(source, raw) {
  const lines = String(raw || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);

  for (const line of lines) {
    runtime.logs.push(`[${source}] ${line}`);
  }
  if (runtime.logs.length > 120) runtime.logs.splice(0, runtime.logs.length - 120);
  publish();
}

/**
 * 试探一个 TCP 端口是否可用。
 * 这里只做 bind 测试，不启动真正业务服务，成功后马上释放。
 */
function canListen(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", () => resolve(false));
    probe.listen({ host: "127.0.0.1", port }, () => {
      probe.close(() => resolve(true));
    });
  });
}

async function pickPort(start = DEFAULT_PORT) {
  for (let port = start; port < start + 30; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`${start} 起连续 30 个端口都被占用`);
}

async function waitForHealth(base, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${base}/api/health`, { cache: "no-store" });
      if (response.ok) return await response.json();
    } catch {
      // 服务刚 fork 出来时短暂连接失败是正常现象，继续重试即可。
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("本地音乐服务启动超时");
}

/**
 * 找 cloudflared。
 *
 * 打包后固定在 process.resourcesPath/cloudflared。
 * 开发模式额外接受环境变量和 build/ 下的本地文件，方便 Windows 本机自测。
 */
function cloudflaredPath() {
  const fileName = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const candidates = [
    process.env.GUGU_CLOUDFLARED || "",
    path.join(process.resourcesPath, fileName),
    path.join(app.getAppPath(), "build", fileName),
    path.join(app.getAppPath(), "runtime", fileName),
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

async function startServer() {
  setPhase("starting-server", "正在启动本地音乐服务…");

  const port = await pickPort();
  const appRoot = app.getAppPath();
  const serverScript = path.join(appRoot, "server", "index.js");
  const dataDir = path.join(app.getPath("userData"), "music-data");

  fs.mkdirSync(dataDir, { recursive: true });
  runtime.port = port;
  runtime.localBase = `http://127.0.0.1:${port}`;

  /**
   * Electron 会为 fork() 自动配置 ELECTRON_RUN_AS_NODE；
   * macOS 还会自动选择 helper executable。
   * 因此用户电脑不需要另外安装 Node.js。
   */
  serverProcess = fork(serverScript, ["--port", String(port), "--data", dataDir], {
    cwd: appRoot,
    silent: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });

  serverProcess.stdout?.on("data", (chunk) => addLog("server", chunk));
  serverProcess.stderr?.on("data", (chunk) => addLog("server", chunk));
  serverProcess.on("error", (error) => {
    addLog("server", error.stack || error.message);
    if (!quitting) setPhase("error", "本地音乐服务启动失败");
  });
  serverProcess.on("exit", (code, signal) => {
    addLog("server", `服务进程退出：code=${code ?? "-"} signal=${signal ?? "-"}`);
    serverProcess = null;
    if (!quitting && runtime.phase !== "restarting") {
      setPhase("error", "本地音乐服务意外退出");
    }
  });

  const health = await waitForHealth(runtime.localBase);
  addLog("launcher", `本地服务已就绪，版本 ${health.version || "unknown"}，端口 ${port}`);
  return health;
}

async function startTunnel() {
  setPhase("starting-tunnel", "正在建立 Cloudflare 公网通道…");
  const binary = cloudflaredPath();
  if (!binary) {
    throw new Error("应用包里没有找到 cloudflared；请重新下载完整安装包");
  }

  tunnelProcess = spawn(binary, ["tunnel", "--url", runtime.localBase, "--no-autoupdate"], {
    cwd: app.getAppPath(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const inspect = (source, chunk) => {
    const text = String(chunk || "");
    addLog(source, text);
    const match = text.match(TUNNEL_RE);
    if (match && !runtime.publicBase) {
      runtime.publicBase = match[0];
      runtime.installUrl = `${runtime.publicBase}/manifest.json`;
      setPhase("ready", "已启动，可以复制扩展安装地址");
    }
  };

  tunnelProcess.stdout?.on("data", (chunk) => inspect("cloudflared", chunk));
  tunnelProcess.stderr?.on("data", (chunk) => inspect("cloudflared", chunk));
  tunnelProcess.on("error", (error) => {
    addLog("cloudflared", error.stack || error.message);
    if (!quitting) setPhase("error", "Cloudflare 通道启动失败");
  });
  tunnelProcess.on("exit", (code, signal) => {
    addLog("cloudflared", `通道进程退出：code=${code ?? "-"} signal=${signal ?? "-"}`);
    tunnelProcess = null;
    if (!quitting && runtime.phase !== "restarting") {
      setPhase("error", "Cloudflare 通道已断开，请点“重新启动”");
    }
  });

  /**
   * Quick Tunnel 在网络差时可能较久才分配域名。
   * 30 秒后只给用户提示，不主动杀掉进程；后面一旦拿到 URL 仍会自动进入 ready。
   */
  setTimeout(() => {
    if (tunnelProcess && !runtime.publicBase && runtime.phase === "starting-tunnel") {
      setPhase("waiting-tunnel", "公网地址生成较慢，仍在等待 Cloudflare…");
    }
  }, 30_000).unref?.();
}

function stopChild(child, source) {
  if (!child) return;
  try {
    child.kill();
    addLog(source, "已发送停止信号");
  } catch (error) {
    addLog(source, `停止失败：${error.message}`);
  }
}

function stopRuntime() {
  stopChild(tunnelProcess, "cloudflared");
  stopChild(serverProcess, "server");
  tunnelProcess = null;
  serverProcess = null;
}

async function restartRuntime() {
  setPhase("restarting", "正在重新启动…");
  stopRuntime();

  runtime.port = null;
  runtime.localBase = "";
  runtime.publicBase = "";
  runtime.installUrl = "";

  try {
    await startServer();
    await startTunnel();
  } catch (error) {
    addLog("launcher", error.stack || error.message);
    setPhase("error", error.message || "启动失败");
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 620,
    height: 680,
    minWidth: 520,
    minHeight: 560,
    show: false,
    title: "咕咕点歌台",
    webPreferences: {
      preload: path.join(app.getAppPath(), "electron", "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(app.getAppPath(), "electron", "index.html"));
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    publish();
  });
}

function installIpc() {
  ipcMain.handle("runtime:get", () => snapshot());
  ipcMain.handle("runtime:copy", () => {
    if (!runtime.installUrl) return false;
    clipboard.writeText(runtime.installUrl);
    return true;
  });
  ipcMain.handle("runtime:restart", async () => {
    await restartRuntime();
    return snapshot();
  });
  ipcMain.handle("runtime:open-owlbear", async () => {
    await shell.openExternal("https://www.owlbear.rodeo/");
    return true;
  });
}

/**
 * CI 专用烟雾测试：
 * 不创建 BrowserWindow、不启动公网 tunnel，只验证“打包后的 Electron 自带 Node”
 * 能否找到并启动原 server/index.js，然后真实访问 /api/health。
 */
async function runSmokeTest() {
  try {
    await startServer();
    const response = await fetch(`${runtime.localBase}/api/health`);
    if (!response.ok) throw new Error(`health 返回 HTTP ${response.status}`);
    const body = await response.json();
    console.log(`ELECTRON_SMOKE_OK version=${body.version} port=${runtime.port}`);
    stopRuntime();
    app.exit(0);
  } catch (error) {
    console.error("ELECTRON_SMOKE_FAILED", error);
    stopRuntime();
    app.exit(1);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on("before-quit", () => {
    quitting = true;
    stopRuntime();
  });

  // 对这个工具来说，窗口关掉就应该停止给玩家提供服务，避免用户误以为已经退出。
  app.on("window-all-closed", () => app.quit());

  app.whenReady().then(async () => {
    if (IS_SMOKE_TEST) {
      await runSmokeTest();
      return;
    }

    installIpc();
    createWindow();
    await restartRuntime();
  });
}
