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
// 仅在上一版 ACK 修复上增加用户主动导出的匿名诊断与 DO 实时只读统计；
// 不能混入尚未完成 Android 真实设备验收的双 GM 时钟与房间快照改造。
// 生产 v3.2.5：撤销 v3.2.4 中允许独立拖动的 iPhone 原生 controls，
// 改成可见按钮直接解锁同 iframe 的无控件音频，严格跟随 GM 时间锚点。
// 不影响已经验证的 2MiB 中继修复、MIME 修复、DO 匿名诊断。
// 尚未在真实 iPhone 上验证，不能宣称已经永久解决后台播放限制。
// 仅在已上线的v3.2.5上修手机端可操作性和首次音频授权。
// v3.3的双GM时钟/大歌单DO快照/预测歌单目前仍独立验收，不混入本次热修复。
// manifest 与播放器诊断共享版本常量，杜绝“已升级却显示旧诊断”的误判。
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
