# ExecPlan：Electron macOS 傻瓜包

## 目标

在不改动现有 Owlbear 音乐业务逻辑的前提下，给咕咕点歌台增加一个 Electron 桌面启动器，让普通用户下载后双击即可：

1. 自动启动内置的 Node 服务；
2. 自动启动随应用打包的 cloudflared Quick Tunnel；
3. 在窗口中显示并一键复制 Owlbear 扩展安装地址；
4. 退出应用时可靠关闭服务端与 tunnel；
5. 不要求用户安装 Node.js、打开终端或手工输入命令。

## 第一阶段：最小 Electron Launcher

- 新增 `electron/main.mjs`：管理应用生命周期、端口、Node 子进程、cloudflared 子进程和 IPC。
- 新增 `electron/preload.mjs`：只暴露必要的安全桥接 API。
- 新增 `electron/index.html` / `renderer.js` / `style.css`：显示启动状态、安装 URL、复制按钮、重试按钮和日志。
- Electron 自启动后直接拉起服务，不要求用户点“开始”。

## 第二阶段：打包

- 使用 electron-builder。
- 业务代码继续放在 app.asar；cloudflared 作为 extraResources 放到应用 Resources 目录。
- macOS 同时生成 arm64 与 x64 的 DMG/ZIP，避免 Universal 包中 cloudflared 架构混用。
- 当前没有 Apple Developer 签名证书，因此 QA 包先不签名/不公证；README 明确 Gatekeeper 绕过方法。

## 第三阶段：CI 与验证

- GitHub Actions 在 macOS runner 上分别下载对应架构的 cloudflared。
- 构建 arm64/x64 安装包。
- 对打包内容做静态检查：应用中存在 server/public/cloudflared，架构匹配。
- 本机 Windows 做 Electron launcher 的逻辑测试，确保服务端能被 Electron 自带 Node runtime 拉起。

## 非目标

- 本轮不做多音轨、UI 大改或 Named Tunnel。
- 不改现有 Owlbear 同步协议。
- 不承诺未签名 macOS 包能绕过 Gatekeeper 双击直接启动；正式发布需 Apple Developer ID + notarization。

