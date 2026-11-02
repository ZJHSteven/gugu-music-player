// 把 OBR SDK（jsDelivr 的 +esm 构建）连同依赖一起本地化。
//
// 为什么必须做：那个产物里有 from"/npm/uuid@9.0.1/+esm" 这样的绝对路径导入，
// 在 OBR 的 iframe 里会解析成 http://localhost:8787/npm/... → 404，
// 整个模块图加载失败，浏览器只会含糊地报
//   Failed to fetch dynamically imported module
//
// 用法：node tools/vendor-sdk.mjs   （幂等）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SDK_DIR = path.join(ROOT, "public", "sdk");
const VENDOR_DIR = path.join(SDK_DIR, "vendor");
const ENTRY = path.join(SDK_DIR, "obr.js");
const VERSION = process.env.SDK_VERSION || "3.1.0";
const CDN = "https://cdn.jsdelivr.net";

fs.mkdirSync(VENDOR_DIR, { recursive: true });

const ABS = /(from\s*["'])(\/npm\/[^"']+)(["'])/g;

const localName = (spec) => {
  // 路径里的 "+esm" 中 "+" 是字面量，正则里必须写成 \+
  const m = /^\/npm\/((?:@[^/]+\/)?[^@/]+)@([^/]+)\/\+esm$/.exec(spec);
  return m ? `${m[1].replace(/^@/, "").replace(/\//g, "-")}-${m[2]}.js` : null;
};

let fetched = 0;

async function vendor(spec) {
  const name = localName(spec);
  if (!name) throw new Error(`无法识别的依赖：${spec}`);
  const file = path.join(VENDOR_DIR, name);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return name;

  const res = await fetch(CDN + spec);
  if (!res.ok) throw new Error(`下载失败 ${spec}: HTTP ${res.status}`);
  let code = await res.text();
  fetched++;

  for (const nested of [...new Set([...code.matchAll(ABS)].map((m) => m[2]))]) {
    const child = await vendor(nested);
    code = code.split(`"${nested}"`).join(`"./${child}"`);
  }
  fs.writeFileSync(file, code);
  console.log(`  依赖 ${name} (${(code.length / 1024).toFixed(1)} KB)`);
  return name;
}

async function main() {
  if (!fs.existsSync(ENTRY)) {
    console.log(`下载 OBR SDK ${VERSION} ...`);
    const res = await fetch(`${CDN}/npm/@owlbear-rodeo/sdk@${VERSION}/+esm`);
    if (!res.ok) throw new Error(`SDK 下载失败：HTTP ${res.status}`);
    fs.writeFileSync(ENTRY, await res.text());
  }

  const src = fs.readFileSync(ENTRY, "utf8");
  const specs = [...new Set([...src.matchAll(ABS)].map((m) => m[2]))];
  if (!specs.length) return console.log("依赖已是本地路径，无需处理");

  console.log(`发现 ${specs.length} 个绝对路径依赖：`);
  let out = src;
  for (const spec of specs) {
    const name = await vendor(spec);
    out = out.split(`"${spec}"`).join(`"./vendor/${name}"`);
  }
  fs.writeFileSync(ENTRY, out);
  console.log(`完成：改写 public/sdk/obr.js，新下载 ${fetched} 个依赖`);
}

main().catch((e) => {
  console.error("失败：", e.message);
  process.exit(1);
});
