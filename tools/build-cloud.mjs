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
manifest.version = "3.2.0";
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log("Cloudflare Static Assets 已生成：", destination);
