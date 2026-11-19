# 云端版当前状态（2026-11-20）

## v3.2.7 iPhone Chrome 无痕模式、下载故障与滚动热修复

- 独立工作区 D:\Workspace\gugu-music-player-hotfix-v327，分支 hotfix/ios-private-cache-v327。从生产 v3.2.6 建立，未混入 v3.3 开发功能。
- 用户 2026-11-19 17:56 UTC 诊断：弹窗与背景 iframe 各接收 2,188,046 字节，服务器各转发约 2.19MB，filesVerified=0、收到 errorName=Error。完整字节传入但未验收；可能是 SHA256 校验或浏览器本地持久存储错误，不能归咎于无痕模式。瞬时 waiting=0 是请求失败清理后的状态，累计 requests=1 证明发起过请求。
- v3.2.6 manifest 已升级，而诊断版本仍硬编码为 v3.2.5。用户报告并不能证明仍运行旧脚本。v3.2.7 让构建清单与诊断共享版本常量，并识别 iOS Chrome 的 CriOS UA。
- 中继新增 wire/integrity/storage/notification 四阶段有限枚举错误诊断；接收完成但 SHA256 不一致明确报告 hash-mismatch。OPFS 和 IndexedDB 同时无法写入时，仅对 SHA256 成功的文件使用 96MiB 有界单iframe会话内存缓存，刷新后丢失；报告可标注 storage=memory，不能充当永久备份。
- iPhone 窄屏触摸视口内，点歌面板高度限制至最多320px，内部 scroll 容器留出150px底部滚动余量，以处理宿主 iframe 名义640px但可见高度较小的情况。420x640 Chrome 触屏仿真：面板高度320px，滚动区265px、内容高1042px，程序滚动750px后底部复制按钮位于顶部177–197px可见。CDP手指滑动模拟未成功，真正iPhone WebKit必须单独验收。
- 完成自动化：Cloud 30/30，build 与 verify 云端v3.2.7通过，传统Node 42/42、Edge UI 61/61。测试覆盖双存储拒绝、校验失败、诊断版本/浏览器字段。真实iOS尚未复测，不能宣称完全解决。
- 播放控制仍由 Owlbear GM 的 Room Metadata/Broadcast 权威时间轴负责；Cloudflare Durable Object 仅负责文件中继，玩家的开启声音不赋予独立拖动或暂停权。

## 当前结论

- **已上线首版**：Cloudflare Worker `gugu-music-cloud` + 自定义域名 `https://music.zjhstudio.com`，可通过 `/manifest.json` 安装 Owlbear 插件。
- 开发分支 `feat/cloud-do-opfs`，独立于原 Electron QA 分支及上游原版。
- 原版靠 Node/SSE/HTTP 管理播放；云版已用 Owlbear Room Metadata/Broadcast 替代，保留原 UI。
- 云版只把音频放在玩家的 OPFS/IndexedDB；Cloudflare Durable Object 仅经可休眠 WebSocket 中继二进制文件，不储存歌曲、不处理播放指令、不发心跳。
- 当前已验证：云版单元测试 **11/11**、原版 Node 服务测试 **42/42**、Edge UI 回归 **61/61**。本地真实 DO 的 2 MiB 与 30 MiB、独立存储环境 3 MiB；公网曾完成 1 MiB 和 GM 离线的 4 MiB 传输，SHA-256 均一致。
- **真实 Owlbear 正式房间 E2E 已通过主要功能**：The Cured Tying 房间的 GM + 两个独立访客，完成官方审批、SDK Metadata/Broadcast、320044B WAV 与 272044B WAV 公网中继、玩家间互传、角色权限、暂停/5.75 秒 seek/恢复、20 秒循环、访客刷新仍保留 OPFS 缓存、同源 iframe 避免重复请求。详细实测证据见 `docs/real-owlbear-e2e-2026-11-19.md`。
- 正式生产最新版 Cloudflare Worker 部署 ID：`df4d2d45-46ef-4cfd-912f-c2c749d04333`；manifest 为 v3.2.1。**没有验证锁屏浏览器的实际扬声器发声**：Chrome 因无用户手势而拒绝 GM 后台 `Audio.play()`，但双方 WAV 可解码，时钟和控制事件已通过。公网 30 MiB 和移动端真机仍待验收。
- GitHub 开发分支为 `ZJHSteven/gugu-music-player:feat/cloud-do-opfs`，本轮最新改动将随验收提交推送；没有合入上游主线或覆盖原 Electron QA 分支。

## 技术约束

- 房间元数据总限 16 KB，云版主动使用约 14 KB 安全上限；超过上限拒绝写入并提示减小歌单。
- WebSocket 每 256 KiB 一块、8 块一个 ACK 窗口，浏览器侧 30 秒断流重试（**非 DO 心跳**），整文件完成后 SHA-256 校验。
- 手机 Safari/iOS 等后台音频与存储驱逐仍需真机验证；`navigator.storage.persist()` 不保证永久保存。
- 浏览器版未实现上游 Node 所依赖的 B 站视频抓取转音频入口，云版前端已暂时隐藏该输入；现阶段仅对本地上传音频功能完成云端迁移。
- `?dev=1` 的模拟 SDK 可跨同源标签模拟 Owlbear 房间，但不能代替 Owlbear 正式房间验收。
- Edge UI 测试偶发 `chrome-extension://abkclgdmdkokpdkbpdkoiiemhcaafbkg` 注入脚本异常，已保留详细异常记录，并只将可明确归属外部扩展的错误排除；最终原版 61/61 通过。

## 下一步

- **2026-11-19 最新收口结论**：真实 Owlbear 三端数据流、跨玩家文件转发、后台时钟、歌单与权限已验收通过；两名测试访客的独立 BrowserContext 和临时 Profile 标签页已关闭。两首仅用于测试的歌曲已从真实房间歌单删除（修订号 15、0 首、停止播放，其他扩展的 Metadata 键保持不变），GM 原站点 OPFS 中对应两个测试文件也已准确清理。原有 GM 房间和已启用的云版扩展保留。后续优先在用户桌面实际可发声时测试音频自动播放解锁、系统后台策略，其次跑公网 30 MiB、移动 Safari/Firefox、IndexedDB 回退。

- 2026-11-19 真实 Owlbear CDP 验收发现首个安装阻塞：Owlbear 页面跨域 fetch 云版 manifest 触发 CORS，已在云版构建工具中为公开静态资源生成 `_headers`，待部署后重验。假 SDK GM/玩家跨标签事件、权限拒绝与独立浏览器 320044 字节文件 SHA256 校验通过。
- CORS 修复已部署（64fa7750），真实 Owlbear 添加自定义插件的弹窗已经能够读取并展示完整 manifest。进一步观察到宿主将相对图标 URL `./icon.png` 拼成了带尾点主机名的异常路径；云版改为绝对 HTTPS manifest 资源地址（v3.2.1），待重新发布重试。当前 Owlbear 扩展列表仍显示大量骨架屏，部分宿主 API 请求异常，不能把“已点击 ADD”当作房间扩展启用成功。
- v3.2.1 绝对 HTTPS manifest 已发布（Cloudflare 版本 4f80353c）。通过日常 Chrome 登录的 Owlbear API 返回的用户扩展资产记录，确认账户确已安装 `https://music.zjhstudio.com/manifest.json`；但房间启用列表仍只有 7 个既有插件，不含咕咕。My Extensions 列表中约 26 个卡片长期显示骨架屏，全部开关 disabled，目前真实房间的 SDK 事件验收受阻，**不得标记成功**。新增在线预检脚本 `npm run verify:cloud`，避免以后再发布 CORS 或相对路径错误。
- 本机 Windows 网络配置下 Node 24 直接 fetch 生产域名出现 ConnectTimeoutError，单独启动的 PowerShell 子进程也超时；只有 DevSpace 的当前 PowerShell 或日常 CDP Chrome 已实测能访问。为了避免伪验收，`npm run verify:cloud` 改为纯离线检查清单、CORS 规则和文件存在性；`npm run verify:cloud:online` 才是实际远端 HTTP/CORS 验证，使用有外网访问能力的环境运行。
- 本轮阶段验收：`npm run build:cloud` + `npm run verify:cloud` + `npm run test:cloud` 全通过；真实 Owlbear 页面通过跨源 `fetch` 验证公网清单 200、v3.2.1、四个 HTTPS 绝对 URL；账户自定义扩展安装资产已核实。当前 Owlbear 房间启用记录不存在该资产；真实房间 SDK E2E 阶段仍标记 blocked，而不是假定已经通过。
- 2026-11-19 已通过 Owlbear 官方 Profile → Edit Room 界面给 The Cured Tying 启用咕咕云版，并从真实 GM 房间确认 / 和 /background.html 两个 Owlbear iframe 已加载；SDK getRole=GM，房间 Metadata 中已有咕咕 state，DO WebSocket 已联通。发现另一个真实 E2E 问题：popover iframe 的 `document.hidden=true`，`requestAnimationFrame` 被浏览器暂停，导致 UI 永远显示「正在连接…」，尽管 SDK 已就绪。已增加隐藏页的单次 `setTimeout` 渲染兜底，待回归部署。
- 真实 Owlbear GM + 独立无账号访客端成功同房间：用户 Profile 编辑启用、玩家请求加入及 GM ADMIT 完整走通。GM 上传 20s/8000Hz 单声道 WAV（320044B），Player popover 与后台都经公网 DO 中继获取并校验 SHA-256，收到了 OBR Metadata rev 2 和 changed 广播。GM 选择播放使真实双方 rev 3；Chrome 锁屏背景 GM `Audio.play()` 因缺少用户手势被拒绝，玩家播放 pending，然而房间计时超过 20s 后仍显示 2:57/0:20：确认为云版音频 ended 事件依赖的自动切歌问题。已加本地时钟兜底、GM seq 去重及 stale ended 拒绝，待构建回归与正式环境验证。

1. 真实 Owlbear 房间内核对 GM/玩家加入、切歌、自动播放限制、移动端后台与断线恢复。
2. 进行公网 30 MiB 大文件长时间下载验收，区分本地快与公网慢的瓶颈；并为超时重试添加客户端可见进度。
3. 视需求增加房主歌曲备份的显式导入/导出，以及替换 B 站提取的合规云端方案。
