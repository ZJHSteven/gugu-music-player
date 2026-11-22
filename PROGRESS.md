# 云端版最新状态（2026-11-23 北京时间）

## 2026-11-23：梅林 v3.3.1 音频收包停滞，v3.3.2 已正式发布

- **梅林真实诊断证据**：Windows Edge/PLAYER，Owlbear SDK ready、roomId、房间音乐状态v1 rev6501及playingInRoom全部正常，room metadata 4243B、pointerFits=true；后台/面板两个独立 Relay Peer 在线，分别发起10/17次请求、超时9/16次。GM提供端在DO累计发送/转发59,123,169B（多轮重复），但面板累计接收524,288B、后台0B，当前未完成分块、SHA256 verified=0，播放器 `readyState=0`、`sourceType=null`。**此轮故障发生在音频二进制传输/浏览器收包阶段，不是当前会话缺失、16KiB容量或音频解码失败**。Cloudflare的转发计数不能等同于接收端实际收包。
- **修复**：在v3.3.2中，新接收端通过 `need.flowControl="ack-v1"` 协商端到端流控，DO在serve转交协商；新版发送端每256KiB等待对端ACK，5秒无确认会重发同一块最多4次，下一块不会提前积压到目标。接收端对重复块/已缓存文件仍发ACK，防旧版8块末端死锁。老版收件人未协商时保留原无ACK发送路径；新旧浏览器可混用。增强匿名诊断：receivedFrames/resentFrames/lastChunkIndex，不收集IP、歌名或房间密钥。因公网收包不完整的真正物理原因仍可能是下游网络/浏览器节流，修复针对传输控制与自动恢复，不宣称证实唯一根因。
- **自动验收**：Cloud单测65/65、原Node42/42、EdgeUI61/61、构建/静态校验通过。隔离本地真实DO随机房间，两名PLAYER同时各接收2,188,046B、故意丢一次ACK后SHA256完全一致；正式公网 `wss://music.zjhstudio.com/relay` 同样通过双PLAYER逐块ACK+丢ACK重发+SHA256（约18.8秒），旧协议3145745B基线亦校验通过（约17.4秒）。正式在线入口6/6 HTTP200+CORS，全部34个构建静态资产线上SHA256逐一比对34/34一致。**梅林本人/他当前GM真实Edge出声仍未验收**。
- **生产发布**：Cloudflare Worker `gugu-music-cloud` 新版本 `0384c3b8-8837-4f49-9737-5ac579103c83`，2026-11-22T16:01:15Z正式部署并经Wrangler记录确认为100%流量；`https://music.zjhstudio.com` manifest版本3.3.2。上一稳定版本3.3.1 `4e2834f2-f129-4436-b372-d89ff6690710` 保留回滚可选。工作目录D:\\Workspace\\gugu-music-player-cloud，分支feat/cloud-do-opfs。
- **下一步**：让梅林与GM都硬刷新Owlbear重新加载v3.3.2（双方诊断版本需一致），用同一roomMatchCode核对；梅林先等待歌曲缓存并留出一次30秒以上接收窗口，再生成诊断，重点看 `receivedFrames`/`resentFrames`/`lastChunkIndex`/`filesVerified`及实际media.playing；若仍卡住，则用新的发送端重传记录判断下游网络/Edge背景节流/实际断线。独立继续iPhone Safari真机声音与后台、P40小停顿、真实长时间同步和macOS Electron QA；不要混淆这些待验收项与本次已发布代码。

## 2026-11-20：v3.3.1 元数据容量诊断已正式发布（最高优先级）

- 生产域名 `https://music.zjhstudio.com` 已从v3.3.0升级到 **v3.3.1**。正式Cloudflare Worker版本 `4e2834f2-f129-4436-b372-d89ff6690710`，Cloudflare API核实最新部署（2026-11-20T09:02:26Z）占 **100% 流量**。旧v3.3.0 `f2e9edc2-3c52-4458-9b7d-42bbfb46d35a` 可作回滚点。
- 本次修复不修改GM同步与音频协议，只补匿名 `roomMatchCode`、元数据`totalBytes/freeBytes/entryCount/musicKeyPresent/musicValueKind/pointerRoomBytes/pointerFits`、GM写入次数/失败阶段；当Owlbear连最小指针都写不进去时，`commit`在写DO前拒绝并展示准确容量错误，避免产生孤儿快照。
- 新版Cloud 60/60、Node42/42、EdgeUI61/61全部通过；生产HTTP200/CORS 6/6，通过线上全部26个可执行/关键静态资源的SHA256逐文件比对，**26/26与本次构建完全一致**，manifest.version确认为3.3.1。
- 梅林当前旧报告仍是v3.3.0，只证明当前房间没得到咕咕会话。必须收集梅林v3.3.1新报告（匿名房间匹配码、元数据字节数/键存在与否/指针可写性）；与该房间GM侧新诊断比较，才能区分房间不一致、GM没有写入、写入因为共享16KiB拒绝、值不合法等。实际Root Cause尚未锁定，不声称本次诊断升级已经让梅林出声。

## 2026-11-20：梅林跨房间无会话 / Room Metadata 接近满额诊断

- 梅林2026-11-20 15:35提供了正式v3.3.0 Edge无痕PLAYER报告：SDK ready=true、roomIdPresent=true、audioEngineResponded=true；getMetadata成功4次、失败0次，metadataChangeEvents=0、lastReadHadMusic=false、hasMusicSession=false。确认不会进入DO音频中继，旧版SDK握手故障此次不成立。
- 用户提醒：梅林加入的是其他房间，先前该房间元数据已接近16KiB；正式Owlbear Room API文档限制整个房间metadata不得超过16kB，且各扩展共享。DO快照仅缩小咕咕完整歌单，仍必须能在Owlbear中写入一个最小指针，否则PLAYER无法定位DO。与“所有内容放进DO就不需要Owlbear一点空间”不同。
- 当前日常Chrome中用户自己的The Cured Tying房间只读抽样：room metadata 4243B、4个键、咕咕state键存在、v1直存、rev6501，并不接近满额；这**不证明**梅林加入的是同一房间，不可据此宣告梅林问题不可能由容量导致。
- 独立热修复工作树 `D:\Workspace\gugu-music-metadata-v331`，分支 `hotfix/room-metadata-diagnostics-v331`。v3.3.1增加匿名roomMatchCode（SHA256截断12hex，两端对照）、metadata总字节/剩余字节/键数/咕咕命名空间是否存在、direct-v1/pointer-v2/invalid状态及指针总需求量、能否装入16KiB；GM写入失败阶段/次数报告。未输出任何其他扩展的键值、房间ID或secret。
- 真实边界专测：其他扩展占用16176字节、最小指针总共16343字节时可正常先写DO再写Owlbear指针；其他扩展占用16316字节、写入指针需16483字节时正确拒绝，而且不会先写DO制造孤儿快照。Cloud 60/60、Node42/42、EdgeUI61/61、v3.3.1 build/verify均已通过。现阶段不能将未拿到梅林新版roomMatchCode及meta尺寸的推断当成最终根因。

## 2026-11-20：v3.3.0 **已经正式部署（最新权威记录）**

- 用户明确要求不要将全部完成的功能永远留在未发布开发分支。已从已合并的 `feat/cloud-do-opfs@a1f7e93` 构建并正式部署 Cloudflare Worker `gugu-music-cloud`，自定义域名 `https://music.zjhstudio.com`；正式 **v3.3.0** Cloudflare Version ID **`f2e9edc2-3c52-4458-9b7d-42bbfb46d35a`**，Cloudflare API 查询最新 deployment（2026-11-20T06:13:23Z）确认 **100% 流量**。
- 回滚点：原稳定线上 v3.2.8 **`86c242d5-e624-4d20-a8a7-3516552d0b98`**，仍保留 Cloudflare 版本；不可误报 v3.2.8 仍为当前线上。
- 上线内容：v3.2.6/3.2.7/3.2.8 的 iOS 提前授权、下载后接续、12 秒按钮稳定、矮屏滚动、OPFS/IDB与96MiB临时内存回退、分阶段匿名诊断、SDK严格身份+有界重试、首次 Owlbear metadata 补偿读取；以及 v3.3 的 GM 统一时间表、预测自然切歌/预加载、30秒时钟校准、闭环偏差恢复、双GM时钟切换、满额歌单 DO 小型状态快照、ZIP原音频备份/恢复。
- 发布前云版55/55、Node42/42、EdgeUI61/61、build/verify通过；发布后 `npm run verify:cloud:online` 在正式域名与 Owlbear Origin 下 **6/6 HTTP200且CORS**；公网逐文件 SHA-256 对比构建输出和线上 **25/25完全一致**，含 manifest、app、engine、SDK、全部关键 cloud 模块；`/room-state` 非法输入返回 HTTP400，证明 DO 快照入口路由经过真实 Worker。云端公开的 manifest.version 确认为3.3.0。
- **代码发布已完成**；尚需真人 iPhone Safari/Chrome、P40 Firefox 与梅林 Edge 无痕在真实 Owlbear 房间验证是否真的发声、短曲长时间播放和同步。不能把测试通过宣称为真机音频无故障；这项真实跨设备验收应单列保留，不得再次阻止已有功能部署，发现实际故障再单独修补/回滚。

## 2026-11-20：生产版 v3.2.8 与未发布 v3.3 集成状态（此节优先）

- **生产已上线 v3.2.8**：Cloudflare Worker Version ID `86c242d5-e624-4d20-a8a7-3516552d0b98`，Cloudflare API 验证该版本承接100%请求。新增梅林 Edge 无痕模式 SDK 严格身份校验、有界重试、首次房间元数据有限重读和匿名诊断；v3.2.7 的 iPhone 触屏滚动、临时内存缓存、错误分层和版本统一仍在。梅林本人仍需要重进房确认是否真的出声。
- **v3.3 尚未上线**：原开发分支有 GM 共享全局时间表、预测切歌、每30秒可控时钟校准、±1.5%音频闭环、双GM切换、16KiB复杂歌单 DO 快照指针与ZIP音频备份等；必须和生产版热修复汇合，不能把云版单元测试等同于真实iPhone和多人验收。
- 独立集成工作区 `D:\Workspace\gugu-music-v33-integration`、分支 `integration/v33-production-hotfixes`，从 `feat/cloud-do-opfs` 合入生产 `hotfix/merlin-sdk-v328`，保留v3.3控制引擎和大歌单逻辑并补上v3.2.7隐私存储/失败诊断/CriOS识别/可滚动高度、v3.2.8元数据读回统计。v3.3构建清单和诊断版本现共用 `CLOUD_RELEASE_VERSION=3.3.0`。
- 本轮合并后的云版 `55/55`、build/verify 云端 `v3.3.0` 通过；原版 Node `42/42`、Edge UI `61/61` 全部通过。**此分支仅用于集成开发；未把 v3.3 部署 Cloudflare，也未替换现有生产 v3.2.8。**

## 最新真实进度（本节优先于后面的历史日志）

- **生产线上已部署 v3.2.6**，Cloudflare Worker ID
  `e5d2a9a7-4b47-4bd2-b5f7-352613cd0ca5`，公网
  `https://music.zjhstudio.com/manifest.json`。已删除 v3.2.4
  向 PLAYER 开放原生音频进度条的错误设计，改为
  **「开启并同步房间声音」**：iOS 可见面板的真实同步点击直接
  `audio.play()`，其 Audio 元素 `controls=false`，GM 操作由
  房间状态驱动。针对用户反馈的**缓存未完成拒绝开启声音、
  12秒循环按钮频闪、iPhone矮窗口无法滚到诊断报告**，v3.2.6
  分离用户手势预授权和完整歌曲缓存（本地静音WAV+同Audio换源）、
  OPFS有限次重读与文件完成通知、删除循环状态强制DOM重建、
  支持100dvh与主内容独立滚动、顶部固定云版诊断入口。
  生产公网manifest以及五份前端JS/CSS/HTML均HTTP200并验证内容。
  **尚未获得 iOS Safari 真机此版成功长期播放和折叠面板后继续发声的
  验收结论；WebKit可能拒绝换音源后无新手势的play()，届时需明确提示。**
- **v3.3.0 开发分支 feat/cloud-do-opfs 已完整合并上述 v3.2.6 修复**，
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
- v3.3.0 云版单元测试合入 v3.2.6 后重新全量跑批 **50/50 通过**，
  构建和离线插件检查通过；仅属于自动化及浏览器模拟验收，
  云版上线与否以最终验收为准，**本记录时生产还不是 v3.3.0**。
- v3.2.6 热修复的传统 Node **42/42**、原版 Edge UI **61/61**
  全量回归已通过。首次 Edge UI 59/61 仅为[K]长轮询2项时序测试
  偶发失败，结束独立 Wrangler 与模拟浏览器环境后完整重测通过。
  v3.3.0 合并完成后尚未单独重跑传统两套，不能把热修复分支成绩
  直接冒充开发版验收成绩。
- **真实隔离浏览器矮屏验收**：模拟iPhone UA、360×420及320×300
  视口，诊断长报告生成成功，复制按钮可滚动到有效点击区域；
  2秒单曲循环8秒内 GM 修订号13→23，玩家授权按钮 DOM
  替换次数0次，当前滚动位置未跳动。该验证使用 Chromium，
  **不等于iPhone Safari真机验证**。
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
