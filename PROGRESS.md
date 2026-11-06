# 项目状态快照

## 当前结论

- 现状：上游 v1.0.3 是 Node 服务 + cloudflared Quick Tunnel；Windows 发布包内置 Node/cloudflared，macOS/Linux 仍要求系统安装 Node。
- 已完成：完成上游架构审计；创建 Electron 二开工作副本；核对 Electron 与 electron-builder 最新文档。
- 正在做：实现 Electron Launcher 和 macOS CI 打包。
- 下一步：完成本机 launcher 自测后推到用户 GitHub fork，使用 macOS Actions 构建 QA 包。

## 关键决策与理由

- 决策 A：不把服务端重写进 Electron main process，而是用 Electron 自带 Node runtime 启动原 `server/index.js`。原因：最小化对已验证服务端逻辑的侵入。
- 决策 B：cloudflared 作为 extraResources 单独打包。原因：它是原生可执行文件，不能依赖 asar 内执行。
- 决策 C：macOS arm64/x64 分开出包。原因：cloudflared 本身是架构相关二进制；首轮 QA 不值得为了 Universal 包增加 merge 复杂度。
- 决策 D：首轮 QA 不签名。原因：当前没有可确认的 Apple Developer ID 证书；CI 可以构建，但无法做可信 notarization。

## 常见坑 / 复现方法

- macOS 从互联网下载未签名应用可能被 Gatekeeper 阻止；测试者需要“右键 → 打开”或在系统设置中允许。
- Quick Tunnel 地址仍然是临时的；Electron 只解决“安装 Node + 命令行启动”的门槛，不解决中国大陆网络可达性和 URL 重启变化。
