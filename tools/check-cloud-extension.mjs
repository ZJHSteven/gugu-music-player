/**
 * 真实 Owlbear 安装入口的线上预检（不需要账号、不会修改房间）。
 *
 * 2026-11-19 实测发现两个只在真 Owlbear 安装时才暴露的问题：
 * 1. Cloudflare Worker Static Assets 默认缺少 CORS，导致 Owlbear 页面
 *    跨域 fetch(manifest.json) 失败，即使直接浏览该 URL 返回 HTTP 200；
 * 2. Owlbear 曾将 ./icon.png 等相对地址解析为带尾点的域名，图片失败。
 *
 * 每次部署后运行本脚本，以真实的 Owlbear Origin 模拟安装时的网络条件，
 * 检验静态文件的跨域访问头、清单字段、URL 及网页入口。
 *
 * 注意：Node.js 的 fetch 本身不会替浏览器执行 CORS 判定，因此这里明确
 * 检查 Access-Control-Allow-Origin，而不是仅凭状态码 200 宣称安装成功。
 */
import { execFileSync } from "node:child_process";

const base = new URL(process.env.GUGU_CLOUD_ORIGIN || "https://music.zjhstudio.com");
const owlOrigin = "https://www.owlbear.rodeo";
if (base.protocol !== "https:") throw new Error("云端正式入口必须是 HTTPS");

/**
 * Windows 本机启用了系统代理时，Node 24 的全局 fetch 不一定读取 WinINET
 * 代理配置，表现为 ConnectTimeoutError；但 PowerShell 7 的 Invoke-WebRequest
 * 可以沿用系统网络配置。预检工具在 Windows 上走这个只读系统请求通道，
 * Linux/macOS 则继续使用标准 fetch。没有任何文件上传或敏感数据发送。
 */
function fetchWithWindowsNetwork(url) {
  const script = [
    "$ProgressPreference='SilentlyContinue'",
    "$r=Invoke-WebRequest -Uri $env:GUGU_VERIFY_URL -Headers @{Origin='https://www.owlbear.rodeo'} -UseBasicParsing -TimeoutSec 15",
    "$content=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$r.Content))",
    "[pscustomobject]@{status=[int]$r.StatusCode;allow=[string]$r.Headers['Access-Control-Allow-Origin'];body=$content} | ConvertTo-Json -Compress",
  ].join("; ");
  const output = execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, GUGU_VERIFY_URL: String(url) },
    encoding: "utf8",
    timeout: 20000,
  }).trim();
  const data = JSON.parse(output);
  return new Response(Buffer.from(data.body, "base64"), {
    status: data.status,
    headers: { "Access-Control-Allow-Origin": data.allow },
  });
}

async function verifyFetch(label, url) {
  const response = process.platform === "win32" && process.env.GUGU_USE_NODE_FETCH !== "1"
    ? fetchWithWindowsNetwork(url)
    : await fetch(url, {
      headers: { Origin: owlOrigin },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}: ${url}`);
  const allow = response.headers.get("access-control-allow-origin");
  if (allow !== "*" && allow !== owlOrigin) {
    throw new Error(`${label} 缺失允许 Owlbear 来源的 CORS 响应头: ${allow || "未设置"}`);
  }
  return response;
}

const manifestUrl = new URL("/manifest.json", base);
const manifest = await (await verifyFetch("插件清单", manifestUrl)).json();
if (manifest.manifest_version !== 1 || !manifest.name ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version || "")) {
  throw new Error("清单格式或版本号无效");
}
console.log(`插件清单：${manifest.name} v${manifest.version}`);

const destinations = [
  ["扩展图标", manifest.icon],
  ["后台引擎", manifest.background_url],
  ["操作按钮图标", manifest.action?.icon],
  ["浮窗主页", manifest.action?.popover],
];
for (const [label, value] of destinations) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error(`${label} 必须使用完整绝对 HTTPS URL: ${value}`); }
  if (url.origin !== base.origin || url.hostname.endsWith(".")) {
    throw new Error(`${label} 主机名错误或多余尾点: ${url}`);
  }
  await verifyFetch(label, url);
  console.log(`✓ ${label}：${url.pathname} HTTP 200 / CORS 正常`);
}

const config = await (await verifyFetch("云端配置", new URL("/config.js", base))).text();
if (!/BARD_CLOUD\s*=\s*true/.test(config)) {
  throw new Error("站点未启用云版 BARD_CLOUD 配置");
}
console.log("✓ Owlbear 跨域安装预检全部通过");
