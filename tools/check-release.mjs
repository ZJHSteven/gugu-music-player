// 发布前自检：扫描当前目录，找出不该上传的东西。
//
//   node tools/check-release.mjs              检查当前项目目录
//   node tools/check-release.mjs ../发布包     检查某个目录
//
// 退出码 0 = 可以发布，1 = 有问题。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(process.argv[2] || path.join(path.dirname(SELF_PATH), ".."));

const SKIP_DIRS = new Set(["node_modules", ".git", ".bin", "data", "vendor", "shots"]);
const SELF = path.basename(SELF_PATH);
const TEXT_EXT = new Set([".js", ".mjs", ".json", ".html", ".css", ".md", ".yml", ".yaml", ".bat", ".sh", ".txt", ""]);

const fatal = [];
const warn = [];

// ---------- 1. 目录级：这些不该出现在发布内容里 ----------
for (const [dir, why] of [
  ["data", "房间存档与服务日志（含 GM 控制令牌、隧道地址）"],
  [".bin", "隧道程序与上次的公网地址（50MB+）"],
]) {
  if (fs.existsSync(path.join(ROOT, dir))) {
    warn.push(`目录 ${dir}/ 存在 —— ${why}。.gitignore 会排除它，但 GitHub 网页拖拽上传不会！`);
  }
}

// ---------- 2. 文件级：隐私与密钥 ----------
const PATTERNS = [
  { re: /\b192\.168\.\d{1,3}\.\d{1,3}\b/, name: "内网 IP（192.168.x.x）" },
  { re: /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, name: "内网 IP（10.x.x.x）" },
  { re: /\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/, name: "内网 IP（172.16-31.x.x）" },
  { re: /[A-Za-z]:\\\\?Users\\\\?[^\\/]+/, name: "本机绝对路径（暴露 Windows 用户名）" },
  { re: /https:\/\/[a-z0-9-]+\.trycloudflare\.com(?!\/manifest\.json)/, name: "你自己的公网隧道地址" },
  { re: /"token"\s*:\s*"[0-9a-f]{16,}"/i, name: "疑似控制令牌明文" },
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(abs, out);
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file);
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file);

  if ([".aac", ".mp3", ".m4a", ".flac", ".wav", ".ogg"].includes(ext)) {
    warn.push(`${rel} —— 你自己放的音乐文件（版权与体积都不适合进仓库）`);
    continue;
  }
  if (!TEXT_EXT.has(ext) || base === SELF) continue;

  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const p of PATTERNS) {
    const m = p.re.exec(text);
    if (!m) continue;
    // README 里的示例地址与占位符不算
    if (/xxxx-yyyy-zzzz/.test(m[0])) continue;
    fatal.push(`${rel} —— 发现${p.name}：${m[0].slice(0, 60)}`);
  }
}

// ---------- 3. 配置正确性：别把别人引到你的后端 ----------
const cfgPath = path.join(ROOT, "public", "config.js");
if (fs.existsSync(cfgPath)) {
  const cfg = fs.readFileSync(cfgPath, "utf8");
  const m = /window\.BARD_API\s*=\s*["'`]([^"'`]*)["'`]/.exec(cfg);
  if (m && m[1].trim()) {
    fatal.push(`public/config.js 里写死了后端地址 "${m[1]}" —— 公开后所有使用者都会连到这台机器上，必须留空`);
  }
}

// ---------- 4. manifest 必须是相对路径（否则 GitHub Pages 子路径会 404）----------
const manPath = path.join(ROOT, "public", "manifest.json");
if (fs.existsSync(manPath)) {
  const man = JSON.parse(fs.readFileSync(manPath, "utf8"));
  const bad = [];
  if (man.action?.popover?.startsWith("/")) bad.push(`action.popover=${man.action.popover}`);
  if (man.background_url?.startsWith("/")) bad.push(`background_url=${man.background_url}`);
  if (man.icon?.startsWith("/")) bad.push(`icon=${man.icon}`);
  if (bad.length) fatal.push(`public/manifest.json 用了根路径（${bad.join("、")}），放到 GitHub Pages 子路径会失效`);
}

// ---------- 5. 许可证 ----------\nif (!fs.existsSync(path.join(ROOT, "LICENSE"))) {\n  warn.push("缺少 LICENSE 文件 —— 没有它默认保留所有权利，别人无法合法复用");\n}\n\n// ---------- 输出 ----------
const line = (s) => console.log(s);
line("");
line(`  发布自检：${ROOT}`);
line("  " + "─".repeat(60));

if (fatal.length) {
  line("");
  line(`  ✗ 必须处理（${fatal.length} 项）：会真的泄露或让插件失效`);
  fatal.forEach((s) => line(`    · ${s}`));
}
if (warn.length) {
  line("");
  line(`  ! 建议排除（${warn.length} 项）：不会被 git 提交，但网页上传会带上`);
  warn.forEach((s) => line(`    · ${s}`));
}
if (!fatal.length && !warn.length) {
  line("");
  line("  ✓ 可以发布：没有内网地址、本地路径、令牌或写死的后端地址");
}
line("");
process.exit(fatal.length ? 1 : 0);
