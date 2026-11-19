# 云端版最新状态（2026-11-19）

## 最新真实进度（本节优先于后面的历史日志）

- **生产线上已部署 v3.2.5**，Cloudflare Worker ID
  `eeb8e44d-36fd-40dd-bb1f-c2fcc4305a20`，公网
  `https://music.zjhstudio.com/manifest.json`。已删除 v3.2.4
  向 PLAYER 开放原生音频进度条的错误设计，改为
  **「开启并同步房间声音」**：iOS 可见面板的真实同步点击直接
  `audio.play()`，其 Audio 元素 `controls=false`，GM 操作由
  房间状态驱动、同一绝对时间轴闭环校准。**尚未获得 iOS Safari
  真机此版成功长期播放和折叠面板后继续发声的验收结论。**
- **v3.3.0 开发分支 feat/cloud-do-opfs 已完整合并上述 iOS 修复**，
  并实现 GM/PLAYER 严格 SDK 就绪判定、有限重连、GM 升权后懒初始化、
  房间统一确定性歌单时间表、单曲/列表循环无需每次等网络广播、
  ±1.5% 局部闭环纠偏、下一首预热、当前曲目优先下载与限并发、
  双 GM 独立设备时钟、ZIP 真实音频备份／恢复、复杂房间 16KiB
  Metadata 快照备用通道。默认继续写 Owlbear 原生状态，
  **只有全房间元数据占用接近 15KiB 时才采用 DO 指针**；快照本身
  最多 60KiB，不保存任何音频字节。
- **真实本地 Cloudflare Durable Object 验证**：20 首歌曲快照
  POST/GET、SHA256、错误摘要、超大输入限制均按预期；2 客户端
  中继 655377B 与 verified 统计一致；完全无 ACK 仍完整转发
  3145745B、SHA256 一致。另有浏览器内真实 GM/PLAYER
  双标签测试：两首 1.25s/1.65s WAV 自动循环，原始 Metadata
  rev 保持不变而客户端可以预测当前歌曲；GM 手动停止和继续、
  iOS UA 模拟的同步播放器跟随，且 `audio.controls=false`。
  浏览器版直接导出真正 ZIP 47577B，删除测试歌单项后从同一 ZIP
  恢复 2 份音频、补回缺失的 1 首歌曲。
- 独立的 16KiB 边界专项：普通房间保持 v1 完整 Owlbear Metadata
  **DO 写入次数为 0**；当歌单增长至 110 首之后转为 v2 指针，
  GM 和 PLAYER 都能读取全部曲目，其他扩展字段原样保留。
- v3.3.0 云版单元测试在本轮异常恢复后重新全量跑批 **46/46 通过**，
  构建和离线插件检查通过；仅属于自动化及浏览器模拟验收，
  云版上线与否以最终验收为准，**本记录时生产还不是 v3.3.0**。
- 传统 Node/Edge UI 测试最近分别为 41/42、60/61：**唯一失败项**
  为在线 B 站音轨代理的上游媒体响应／解码，这个外部依赖和
  Cloudflare 云版（本身不支持 B 站抓取）本轮修复无关；
  不能谎称两个测试套件 100% 通过。
- **真实设备**：P40 Android Firefox 已由用户亲自听到来自 Owlbear
  房间的音频，但仍偶有小停顿；iPhone Safari 曾多次中断、报
  `NotAllowedError`、音频错误码 4，QQ 内置浏览器也报错误码 4；
  修复了 OPFS File MIME 丢失与跨 iframe 手势转发设计，但
  仍需新版本 iOS 真实听感、后台、循环与设备声学相位对照。
  **梅林原始诊断已明确找到**：11月19日18:46，他在自己房间的
  Edge 可正常解码并播放（420秒音轨，audio.paused=false、
  readyState=4、currentTime≈23.65、无媒体错误）；18:57 加入用户
  正在播放且元数据rev623的 GM 房间时，梅林报 PLAYER、
  hasMusicSession=false、trackLoaded=false、engine unavailable、
  relay=null。这不属于 DO 传输失败，更接近其浏览器 Owlbear SDK
  未完成握手、无有效 roomId、跳过 CloudBridge 的启动故障。
  旧版v3.2.3 存在 waitReady 超时继续、未知role默认为 PLAYER、
  无 roomId 不建 Bridge 的因果链；但缺当时 sdkReady/roomIdPresent
  字段，**是高证据支持的假设而非确认根因**。v3.3 加入显式身份
  校验、握手回放、有限重试及元数据重读，**尚未部署且未获梅林
  修复后的诊断报告，不得宣称梅林问题已解决**。

---

## 以下为早期 v3.2.1 开发阶段的历史记录（不代表当前生产版本）

**2026-11-19 16:55 外部房间排障：** 日常 Chrome 作为 PLAYER 进入别人的 Owlbear 房间 `The Muggy Proof`，云版面板和后台均已加载、SDK 返回 PLAYER，但是 `com.zjhstudio.gugu-cloud/state` 元数据字段**不存在**，因此 `CloudBridge.state=null`、没有播放列表、没有建立音频 DO 连接；这是「这间房的 GM 没有创建咕咕云版播放会话」，不是文件收不到或音频未解码。该房间已有其他独立音乐扩展的播放字段 `keegan.dev.djinni/currently`、`com.obr-suite/music-board:session`；至少存在 Djinni 和 Music Board 的播放状态，不能把它们的音频误认为咕咕。已修正 PLAYER 无咕咕状态时的 UI 提示，不再错误显示「GM 还没开始播放」/「我是主持」；当前**只完成本地代码修复，不重新发布**，以免在别人测试时切换未经 Android 实机验证的 v3.2.2。线上仍 v3.2.1。本轮未更改他人房间的任何状态。

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

- **2026-11-19 同步与 P40 专项（未发布的新改动）**：已发现旧版 CloudBridge 只对 PLAYER 发起时钟校准，同一 GM 账号电脑/手机两端都为 GM 时，时间锚点可能按错误的设备时钟解释，原版 Engine 的 3 秒硬 seek 与 ±6% 速度追赶可能制造 12.4 秒歌曲反复中断。现在添加设备级 clockId、只允许指定 clockId 响应广播时间探针、每 5 分钟校准一次、跨 GM 设备控制操作转换锚点、只允许播放源设备自动 ended；单曲循环保留真实播放相位，温和 ±1.5% 纠偏，对严重长期偏差设置限频硬 seek。移动端实验设备 P40 Android12/API31，ADB 可连接，已从 Mozilla 官方分发网站安装 Firefox Android 160.0.1 ARM64，但当前仍被华为锁屏覆盖：尚未完成 Firefox 首次启动、远程调试与真实双设备播放验收。**这些代码目前属于本地待验收修改，不得宣称已解决实际 Safari 音频中断或完成发布。**
- 同批本地开发：正式 Manifest 作者改为「鸽翅、Moga」，简介转为面向用户的歌单/音乐功能介绍，计划 v3.2.2；晚加入用户先完整下载当前歌曲，再低并发预取歌单；开始加入本地 ZIP 完整音频备份导出和恢复。这里的当前歌曲优先下载不等于已经支持 HTTP Range / 流式边下边播，正式浏览器功能和 ZIP UI 仍需验收。

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
