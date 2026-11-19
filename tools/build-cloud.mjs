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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "public");
const destination = path.join(root, "dist-cloud");
// 开发服务器在 Windows 上读取静态文件时可能锁定输出目录，整个 rmdir 会报
// EBUSY。直接覆盖拷贝只更新受 Git 管理的 public/ 资源，不影响正在运行的服务。
// 全新 worktree 的 dist-cloud/ 本来不存在；正式部署可用 rm -r 离线清理旧产物。
await fs.mkdir(destination, { recursive: true });
await fs.cp(source, destination, { recursive: true });
await fs.writeFile(path.join(destination, "config.js"),
  "// 云版：播放同步在 Owlbear，文件中转只使用 Durable Objects。\n" +
  'window.BARD_API = "";\nwindow.BARD_CLOUD = true;\n', "utf8");

const manifestPath = path.join(destination, "manifest.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
manifest.name = "咕咕点歌台 · 云端版";
manifest.description = "咕咕点歌台云端版：OPFS 本地曲库、DO 按需文件共享、Owlbear 房间播放同步。";
// 仅修补生产版音频发送端 2 MiB ACK 硬阻塞；不同于尚未实机验收的
// 开发分支 v3.2.2，其他功能和房间元数据格式仍维持上一版。
manifest.version = "3.2.2";

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
