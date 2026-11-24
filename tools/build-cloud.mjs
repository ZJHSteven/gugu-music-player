/**
 * 将上游 public/ 静态网页复制为 Cloudflare Workers Static Assets。
 *
 * 不改动原有的网页 HTML/CSS，也不影响 Node/Electron 版本。
 * 唯一替换的是配置：开启 CloudBridge 并屏蔽原来的 Node REST 调用。
 * 结果目录 dist-cloud/ 是构建产物，不提交到 Git。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLOUD_RELEASE_VERSION } from "../public/cloud/release-version.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "public");
const destination = path.join(root, "dist-cloud");
// Windows 的开发服务器可能锁住整个输出目录，避免整体 rmdir。
// 但仅覆盖拷贝会留下源码已经删除的旧静态文件（如原音频直链下载模块）。
// 复制后定向清理已不存在于 public/ 中的文件，避免把停用模块重新发布。
await fs.mkdir(destination, { recursive: true });
await fs.cp(source, destination, { recursive: true });
async function pruneStaleAssets(fromDir, toDir, rootLevel = false) {
  for (const entry of await fs.readdir(toDir, { withFileTypes: true })) {
    // 两个额外生成的资产不要求存在于 public/。
    if (rootLevel && (entry.name === "config.js" || entry.name === "_headers")) continue;
    const sourceEntry = path.join(fromDir, entry.name);
    const outputEntry = path.join(toDir, entry.name);
    let original;
    try { original = await fs.stat(sourceEntry); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      await fs.rm(outputEntry, { recursive: true, force: true });
      continue;
    }
    if (entry.isDirectory() && original.isDirectory()) {
      await pruneStaleAssets(sourceEntry, outputEntry);
    }
  }
}
await pruneStaleAssets(source, destination, true);
await fs.writeFile(path.join(destination, "config.js"),
  "// 云版：播放同步在 Owlbear，文件中转只使用 Durable Objects。\n" +
  'window.BARD_API = "";\nwindow.BARD_CLOUD = true;\n', "utf8");

const manifestPath = path.join(destination, "manifest.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
manifest.name = "咕咕点歌台 · 云端版";
manifest.author = "鸽翅、Moga";
manifest.description = "为 Owlbear Rodeo 房间共享背景音乐与音效：GM 上传并管理歌单，玩家同步收听，支持播放暂停、切歌、进度控制、循环播放和个人音量调节。";
// v3.3.0 开发版已整合正式生产v3.2.6（iOS提前授权、按钮稳定、矮屏滚动）
// 及未发布的全局时间表、闭环纠偏、GM升权、16KiB快照降级与ZIP备份。
// 不得把自动化模拟当成Safari真机的音频授权/后台连续播放已验收。
manifest.version = CLOUD_RELEASE_VERSION;

// 真正的 Owlbear 房间安装时还发现：宿主对相对路径 ./icon.png 的解析
// 偶尔变成 https://music.zjhstudio.com./icon.png（主机名末尾多出一个点）。
// 这会让图标、背景 iframe 和点歌面板加载失败。云版明确写出完整 URL，
// 避开宿主的路径拼接细节；原 Node/Electron 版的相对路径完全保留。
const cloudOrigin = (process.env.GUGU_CLOUD_ORIGIN || "https://music.zjhstudio.com").replace(/\/+$/, "");
manifest.icon = `${cloudOrigin}/icon.png`;
manifest.background_url = `${cloudOrigin}/background.html`;
manifest.action = {
  ...manifest.action,
  icon: `${cloudOrigin}/icon-action.svg`,
  popover: `${cloudOrigin}/`,
};
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

// Owlbear Rodeo 的扩展管理页运行在 https://www.owlbear.rodeo，
// 安装自定义插件时会从 Owlbear 页面跨域 fetch(manifest.json)。
// Workers Static Assets 默认不返回 Access-Control-Allow-Origin，
// 于是清单虽然浏览器直接访问 HTTP 200，安装对话框仍无法加载。
//
// Cloudflare Workers Static Assets 原生支持 _headers。云版所有静态文件
// 本来就是公开资源，允许跨源 GET 不泄露用户房间数据；房间/音频不走
// 静态资源，这条规则也不会作用到 /relay WebSocket 或 DO。
await fs.writeFile(path.join(destination, "_headers"),
  "/*\n  Access-Control-Allow-Origin: *\n",
  "utf8");
console.log("Cloudflare Static Assets 已生成：", destination);
