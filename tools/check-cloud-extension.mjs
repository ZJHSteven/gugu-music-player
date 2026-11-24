/**
 * 云端版 Owlbear 插件安装预检。
 *
 * 默认对 dist-cloud/ 构建产物进行完全离线、可重复的结构检查。
 * 这适合本机无法直接经 Node.js 访问公网（例如 Windows 系统代理）的场景。
 *
 * 通过 `node tools/check-cloud-extension.mjs --online` 额外验证远端站点：
 * 从 Owlbear 来源模拟 fetch，严格检查 HTTP 状态和 CORS 响应头。
 * 注意：Node.js fetch 不执行浏览器 CORS 判定，需要手动读取响应头。
 *
 * 真实浏览器端的跨源 fetch 验证已经使用 Owlbear 已登录 CDP Chrome 进行，
 * 在此处不把“静态配置正确”伪称为“线上网络一定可达”。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(repo, "dist-cloud");
const origin = new URL(process.env.GUGU_CLOUD_ORIGIN || "https://music.zjhstudio.com");
const owlOrigin = "https://www.owlbear.rodeo";

const read = (file) => fs.readFile(path.join(dir, file));
if (origin.protocol !== "https:") throw new Error("正式安装入口必须使用 HTTPS");

async function listFiles(root, folder = root) {
  const files = [];
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    const target = path.join(folder, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, target));
    else if (entry.isFile()) files.push(path.relative(root, target).replaceAll("\\", "/"));
  }
  return files;
}
const expectedAssets = new Set([
  ...await listFiles(path.join(repo, "public")), "_headers", "config.js",
]);
const publishedAssets = await listFiles(dir);
const unexpectedAssets = publishedAssets.filter((file) => !expectedAssets.has(file));
const missingAssets = [...expectedAssets].filter((file) => !publishedAssets.includes(file));
if (unexpectedAssets.length || missingAssets.length) {
  throw new Error(`构建产物与 public/ 不一致：残留 ${unexpectedAssets.join(", ") || "无"}；缺失 ${missingAssets.join(", ") || "无"}`);
}
console.log(`✓ 静态资源精确同步：${publishedAssets.length} 个文件，无已删除模块残留`);

const manifest = JSON.parse((await read("manifest.json")).toString("utf8"));
if (manifest.manifest_version !== 1 || !manifest.name ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version || "")) {
  throw new Error("manifest.json 的基础字段格式无效");
}
console.log(`插件：${manifest.name} v${manifest.version}`);

const headers = (await read("_headers")).toString("utf8");
if (!/^\/\*\s*\n\s*Access-Control-Allow-Origin:\s*(?:\*|https:\/\/www\.owlbear\.rodeo)/mi.test(headers)) {
  throw new Error("_headers 未提供 Owlbear 可以使用的静态资源 CORS 规则");
}
console.log("✓ 静态资源 CORS 配置存在");

const urls = [
  ["扩展图标", manifest.icon],
  ["后台音乐引擎", manifest.background_url],
  ["操作按钮图标", manifest.action?.icon],
  ["点歌面板", manifest.action?.popover],
];
const targets = [new URL("/manifest.json", origin)];
for (const [name, raw] of urls) {
  let url;
  try { url = new URL(raw); }
  catch { throw new Error(`${name} 必须使用完整的绝对 HTTPS URL：${raw}`); }
  if (!/^https:\/\//.test(String(raw)) || url.origin !== origin.origin ||
      url.hostname.endsWith(".")) {
    throw new Error(`${name} 存在相对路径、错误域名或结尾点：${raw}`);
  }
  const file = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  if (file.includes("..") || path.isAbsolute(file)) throw new Error(`${name} 资源路径不安全`);
  const bytes = await read(file);
  if (!bytes.length) throw new Error(`${name} 资源为空：${file}`);
  console.log(`✓ ${name}：${url.pathname}（${bytes.length} B）`);
  targets.push(url);
}

const config = (await read("config.js")).toString("utf8");
if (!/BARD_CLOUD\s*=\s*true/.test(config)) throw new Error("未启用云版 BARD_CLOUD");
targets.push(new URL("/config.js", origin));
console.log("✓ 离线部署构建预检通过");

if (process.argv.includes("--online")) {
  console.log("开始在线验收：使用 Owlbear Origin 检查真实的 HTTP / CORS 响应");
  for (const url of targets) {
    const res = await fetch(url, {
      headers: { Origin: owlOrigin },
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    const cors = res.headers.get("access-control-allow-origin");
    if (!res.ok || (cors !== "*" && cors !== owlOrigin)) {
      throw new Error(`${url.pathname} 响应不符合 Owlbear 安装要求：HTTP ${res.status}, CORS ${cors}`);
    }
    console.log(`✓ ${url.pathname}：HTTP ${res.status}，CORS ${cors}`);
  }
  console.log("✓ 公网在线预检通过");
}
