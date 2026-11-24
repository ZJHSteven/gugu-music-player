## 2026-11-24 · v3.3.10 歌单管理、多端 GM、移动惯性（已发布）

- 统一歌曲操作图标 24×24px，内部 SVG 14px；点击铅笔就在原歌曲标题处输入，取消/保存不再额外增加一行。分类加号在原胶囊原地动画展开，空白变叉号、有字变勾号。
- 歌单支持左侧拖动把手和键盘上下移动，调用已有 playlist.move 后保存房间 Metadata；改名、排序、分类创建、移入分类都不改变当前播放 anchor、seq 或 clockId。
- 各 GM 设备各有独立 OPFS。手机新加入时显示「本机待同步」、请求中显示「正在同步」，暂时无在线来源提示「等待音源设备上线」，仅真正校验异常标红。电脑上线后可经 DO 自动补文件，DO 不持久保存音频原件。
- 修复每次缓存巡检瞬间插入/删除告示、毫秒级缓冲状态触发整张歌单重绘的闪烁。
- iPhone JS 手动滚动兜底加入指数减速惯性、下一次触摸立即停止，并让 Safari 原生惯性优先；真机手感待用户复测。
- 真 Chrome 测试五枚歌曲按钮24px、原地重命名、胶囊分类保存、键盘和鼠标拖动使曲目 ID 顺序变化且 playback.anchor 不变。独立 Chrome 浏览器存储的两个 GM 经 DO 实传 120000B，接收端 requested=1、verified=1、owned=true、localMissing=0。测试房间使用随机独立标识，未动用户真实房间。
- **已发布**：云版95/95、旧Node42/42、构建及Cloudflare dry-run全部通过。正式域名 https://music.zjhstudio.com 的 manifest 为 v3.3.10，首页/JS/CSS/后台播放器等6项在线资源均HTTP200；Worker版本ID `38190485-3b1c-4e2a-bfb0-ce845bac0792`。
- **GitHub**：电脑原GitHub凭据过期，改用已连接的GitHub Git数据接口。逐一上传并核对全部16个修改文件的Git blob SHA，生成的完整树 `aaa4ad1282c0ccd6f8710898f0574130d9a65e57` 与本地测试提交完全一致。fork分支 `feat/cloud-do-opfs` 更新到 `f7b165b199ab909fab35ec060177504c72a7827b`，上游PR#1代码head自动更新；但原仓库API权限403导致标题/正文无法同步，原有上游合并冲突仍在。
- **本地安全对齐**：将历史6个本地提交保留在 `backup/v3.3.10-pre-api-sync-20261124`，原工作分支同步到 fork 新head，Git工作区干净；真机Safari惯性手感仍需用户反馈。

## 2026-11-24 · v3.3.9 iPhone 滚动修复第二轮（已发布，待真机验收）

- 用户明确反馈 v3.3.8 真机 Safari 中仍不能滚动。重新分析：仅让 `.app` 填满 iframe 并不足够，宿主可能把 Manifest 640px 的 iframe 裁成可见约470px，而内部 .main 仍按640px计算是否溢出。
- 采用三重独立修复：通过官方 Owlbear `action.setHeight` 将窄屏 iPhone 弹窗请求高度降低至设备屏幕的约58%（上限500px）；WebKit 兼容的 fixed .app + .main 滚动安全余量；顶部新增 ↓/↑ 翻页按钮可直接推动 scrollTop。iOS 手指上滑原生未生效时使用非侵入式 touchmove 回退，跳过所有表单和播放器拖动控制。
- 测试：Chrome 触屏390px宽，真实640px iframe被470px宿主裁切：旧版本 `.main` scrollRange仅35px，底部控件最大滚动后仍超出裁剪；新版本可通过手势移动140px、点击箭头移动229px，目标控件完整出现。静态资源使用 v3.3.9 查询参数避免旧Safari缓存；匿名诊断新增 iframe/滚动数值供真机后续验证。
- iOSLab状态确认专用测试iPad离线，且明确拒绝回退到未授权iPhone；本轮尚无法声称真实iPhone WebKit端到端通过。
- **生产发布**：已部署 https://music.zjhstudio.com，Worker `gugu-music-cloud` 版本 ID `9ed0456c-ed52-410c-800f-35157a383645`；线上 manifest=3.3.9，HTML 加载 `style.css?v=3.3.9`、`app.js?v=3.3.9`，包含顶部 ↓ 按钮、新触摸兜底和 Owlbear Action 高度调整模块。
- **验证**：云版 88/88、旧 Node 42/42、构建和发布前检查、线上 HTTP/CORS 6/6 均通过；模拟 Owlbear 外层 470px 裁切内部 640px iframe，旧版本 scrollRange 35px 看不到底部，新版本手势移动140px、按 ↓ 移动229px 使底部进入可见区。在320px触屏窗口顶栏未溢出。
- 未连接真实 iPhone WebKit，设备端表现必须由用户复测；如果仍失败，可从面板顶部设置打开诊断并生成带 `mobileLayout` 数值的匿名报告。

## 2026-11-24 · v3.3.8 修复 Owlbear iPhone 浮窗半屏空白（正式上线）

- 用户截图中 PLAYER/DM 面板顶部「正在播放」卡片正常，但黄色「开启并同步房间声音」按钮在中途被截断，下方整个 Owlbear iframe 是空白背景。
- 直接定位于 `public/style.css` 旧触屏窄屏规则 `.app { height:min(100dvh,320px); max-height:min(100%,320px) }`，以及额外 150px 的 `.main` 底部 padding；两者来自历史的 iOS 滚动临时绕过，不适合新的高浮窗。
- 现改为移动端 `.app{height:100%;max-height:100%}` 填满 iframe，`.main` 保持原 flex/overflow-y:auto 和正常 safe-area 底边距。桌面端规则不变，避免影响房间音频和歌单。
- CDP Chrome 移动触屏仿真 390×650 证实旧 app=320px、新 app=650px；两个内嵌 iframe 高 280/620px 时 app 高度准确匹配且可滚动到最后元素。新增自动化 CSS 回归测试。
- **生产发布**：v3.3.8 已部署至 `https://music.zjhstudio.com`，Cloudflare Worker `gugu-music-cloud` 版本 ID `f44d8e94-e285-48ce-ab32-5ade4e167954`。线上 manifest 3.3.8，CSS 已没有 320px 限高和 150px 底部占位；正式域名同样在 CDP Chrome 390×650 触屏仿真下实测 `.app` = 650px、`.main` = 595px 且 `overflow-y:auto`。
- 云版单测 **84/84**、旧 Node 自检 **42/42**、正式静态资源 HTTP/CORS **6/6**、构建与发布前检查全部通过。桌面触屏模拟已确认修复，仍需用户在实际 iPhone Safari / Owlbear 宿主上复核最终观感。

## 2026-11-24 · v3.3.7 补传音频版本差异与 PLAYER 快速预取（正式上线）

- 上版 v3.3.6 的「重命名」已通过 UI 与状态机测试，且不会更改音频文件哈希或播放时间轴；本版继续保留。
- 单曲补传改为 **检查 → 显示 SHA-256 不匹配警告 → 二次确认后改用新哈希保存并更新所选曲目元数据**；用户取消则完全不改 Metadata，新文件不能冒充旧文件写入旧哈希键。测试覆盖防止其他设备中途更改歌单而旧确认越权覆盖。
- 发现上一版当前曲优先逻辑把历史歌曲排在下一首前面；现修正为「当前 → 未来 → 历史」，且前两首音频巡检完成即可发送补取请求，不必等大歌单剩余 SHA-256 全量扫描完毕。
- **E2E 已通过**：Chrome 在隔离 GM 房间用两份内容不同的真实 WAV 测试，警告确认 UI 可见，取消不修改状态，确认后新 SHA-256 替换旧歌单引用、红色缺失标记消失、第二首音频哈希保持原样、播放序号不变，ZIP 可成功生成。旧版 GM 重命名逻辑同样保留。
- **发布验收**：云版 83/83、旧 Node 42/42 全通过，构建/离线静态资源校验、敏感信息扫描、Wrangler dry-run、正式站点线上 Owlbear 静态资源 HTTP/CORS 6/6 通过。Cloudflare Worker `gugu-music-cloud` 部署 ID `8a1dc552-ab67-4b4d-b2e5-15852f63a6fd`，正式域名 `https://music.zjhstudio.com`，线上 manifest 为 v3.3.7。真实 Chrome 本地隔离房间与正式站点静态页面均已验收。
- **GitHub**：功能提交 `be35dce200c8fe4cb1c6c211f137230bceb641f1` 已推至 `ZJHSteven/gugu-music-player:feat/cloud-do-opfs`；上游 [PR #1](https://github.com/doveris263/gugu-music-player/pull/1) 标题与描述更新至 v3.3.7。PR 仍 OPEN，当前 CONFLICTING，后续要合并需另行处理与上游并行更新的冲突。
- **收尾**：删除仅供测试的两份 WAV OPFS 文件、隔离房间本地 Metadata，关闭两枚 Chrome 测试标签；停掉本地 Wrangler 8790 测试进程。没有修改用户真实 Owlbear 房间的歌曲。

## 2026-11-24 · 云版 v3.3.6（正式上线）

- **UI**：移除 HTTPS 直链输入及其模块，保留旧 `kind=url` 音源兼容；B站/YouTube 引导简化成字号更大的 Parabolic GitHub Releases 链接；移除重复说明和云端无心跳口号；ZIP 下载按钮改成居中、无下划线的标准按钮样式。
- **GM 曲目管理**：增加逐曲重命名、红色「原文件缺失」标记、原文件补传按钮（支持拖入对应歌曲行）。重命名只更新 Metadata，播放 `seq/anchor` 不改变；补传严格校验 SHA-256/大小，使用现有 OPFS→DO 分块传播，不产生新歌单项目。
- **可靠性**：首次取得歌单和后续状态变化时重新核对每首本机缓存的长度和 SHA-256；损坏 Metadata 明确报错；本机缺文件不代表全房间无源。DO 返回暂无来源后等待约 2.5 秒再广播故障，多次断流也广播，来源重新出现时清理告警，不影响其他歌曲播放、预测与定期校时。
- **备份**：ZIP 导出前查完整歌单文件。恢复前检查格式版本、ZIP CRC 和每份音频 SHA-256；不匹配/ZIP缺失项目可报告并跳过，成功部分保留，同名不同哈希不覆盖现有歌曲；结果在「设置」页持续展示。
- **额外修复**：真实 PLAYER 加入测试发现 WebSocket `onopen` 会抢在首次异步 OPFS 扫描前，误将尚未填充的 `tracks=[]` 覆盖完整歌单；改为即时保留 `desiredTracks`，上线后仍按当前曲目优先取源。新增自动化竞态回归测试。
- **构建确定性**：Windows 下不整体清空 `dist-cloud/`，改为增量复制后删除源码已移除的过期文件，并在 verify 检查完全一致；已确认旧 `remote-import.js` 不再出现在发布资产中。
- **预发布验收**：云版单测 82/82 通过，正式构建、静态资源校验、发布敏感信息检查和 Wrangler dry-run 均通过；Chrome 访问临时 `http://127.0.0.1:8790` 隔离房间验证 GM 初次与刷新后的全歌单核对、红色缺失标签、错误SHA拒绝补传、正确补传与 ZIP 恢复、重命名不改时钟、ZIP下载按钮无下划线。另开 PLAYER 页确认3首歌完整可见、确实发起缺失请求且向 GM 广播缺失音源。
- **正式部署**：原域名 `https://music.zjhstudio.com`，Worker `gugu-music-cloud` 版本 ID `6ce6b260-a00e-4732-bd82-036bc69e44c0`，Manifest `3.3.6`；保留旧房间/DO 绑定，不涉及迁移。线上静态资源 HTTP 200+CORS 6/6 全通过；删掉的 `/cloud/remote-import.js` 返回 HTTP 404，新 `source-health.js` HTTP 200。真实 Chrome 正式域名隔离 GM 页确认只显示本地上传与较大的 Parabolic 引导，备份/Metadata 说明正常。
- **额外兼容自检与归档**：原版 Node `npm run selftest` 在本机 8799 端口恢复空闲后重跑，**42/42 通过**。本地 Wrangler 临时服务器已停止（8790 端口释放），隔离 Chrome GM/PLAYER/线上测试标签均关闭，测试房间元数据及两个测试 WAV 文件也已清理。没有向用户真实 Owlbear 房间注入歌曲。
- **GitHub**：`feat/cloud-do-opfs` 已推送到 `ZJHSteven/gugu-music-player`，功能代码提交 `111b48cd99e31dae66e90c4408dcd24fb1061cd3`；上游 `doveris263/gugu-music-player` 的 [PR #1](https://github.com/doveris263/gugu-music-player/pull/1) 已更新为 v3.3.6 的功能/测试/部署说明，当前仍为 OPEN，且因上游并行更新存在合并冲突，尚未合并。

## 2026-11-23 · v3.3.5 云版音频导入界面精简（正式上线）

- 用户选择手动下载方案：Parabolic 开源图形下载器（底层 yt-dlp），下载 B 站 / YouTube 音频后再用咕咕 GM 现有本地音频上传入口导入。
- 云版隐藏失效的 BV 输入框与添加按钮；保留 HTTPS+CORS 直链、本地音频导入、OPFS 与 DO 按需中继；添加单行官方 Parabolic GitHub Releases 链接，原 Node 模式兼容 BV 旧入口。
 **已部署**：沿用正式域名 `https://music.zjhstudio.com`，Worker `gugu-music-cloud` 发布 ID `3ab1808a-b661-4d94-afe0-2caf2766a600`，manifest 版本 3.3.5；39 个静态资源中仅更新相关 UI/版本文件，DO 绑定和房间配置未更改。
 **验证通过**：云版单测 78/78；构建、静态资源、本地发布检查、Wrangler dry-run、正式域名在线 6/6 HTTP 200 + CORS 校验均通过。桌面 Chrome 在隔离 GM 房间手动切换到「添加」页，确认 `#bili` 与 `data-act=add-bili` 不存在，本地文件和直链功能可见，Parabolic Releases 链接及一行说明正确；空歌单老文案中的 BV 号也已同步修正。
 **无关遗留限制**：额外尝试旧 Node `selftest` 时本机 TCP 8799 端口被其他进程占用，导致自检未启动；云版回归与正式浏览器验收不受此影响，未为跑自检擅自停止占用该端口的进程。

# 2026-11-23 · 云端 v3.3.4 正式发布与真实浏览器验收

- **正式部署成功**：Cloudflare Worker `gugu-music-cloud`，版本 ID `21ec6524-587d-4050-92d9-91a4ad9092a1`；保留原域名 `https://music.zjhstudio.com` 及既有 Owlbear 扩展配置，正式 manifest `version=3.3.4`，在线 6/6 HTTP 200+CORS 全通过。
- **B 站功能暂不支持但保留输入 UI**：在正式云版里提交 BV 号/B 站链接立即弹出“暂不支持”，不外呼 B 站、不调用 Worker 网关；生产 `/api/bilibili/resolve` 返回 404。此前试验性的 B 站抓取 Worker 模块/路由已删除，两个临时部署 `gugu-bili-api-probe-1123` 与 `gugu-music-bili-preview-20261123` 已删除。原版 Node 后台及 Cloudflare 临时隧道均已停止，Owlbear 房间仅保留云端版启用；原 Node 路径源码只保留兼容测试，不参与部署。
- **音频直链已上线且 E2E 验收通过**：GM 支持 HTTPS+CORS 音源链接及可选标题，在浏览器下载完整音频、按 64MiB 上限和真实媒体文件头校验后写 OPFS、生成 SHA256，并由现有 DO 中继广播可供音频。隔离测试房间实际导入 MP3 `39868B`，歌单项 kind=url、hash 64 hex、mime=audio/mpeg，`writeAttempts=2`、`writeFailures=0`；ZIP 备份实得 `40529B`，PK 文件头通过，未向真实 Owlbear 房间添加测试曲目。URL 的临时参数不进入共享曲目元数据。
- **设置页收纳日志**：GM 的诊断区域只在“设置”显示，PLAYER 增加按需设置/诊断入口，歌单页不再显示冗长日志；顶部快捷按钮改为“设置”。在生产域名隔离 devroom 真浏览器验证 BV 提交的 B 站网关 fetch 次数为 0，设置页备份/诊断入口存在，歌单页隐藏诊断；修复“已导入、未播放”时误显示“歌单是空的”。
- **DO 休眠/费用**：Worker 仅保留现有 `/relay`、`/room-state`、`/relay-diagnostics` 按需业务，`assets.run_worker_first=["/relay"]`；DO 通过 `ctx.acceptWebSocket` 与持久 attachment 支持空闲休眠，无新增 B 站网络抓取、定时器、闹钟、Node 常驻音频服务器。房间播放同步仍由 Owlbear Metadata/Broadcast 与浏览器时间轴完成，DO 主要做有需要时的音频转发和状态快照。
- **回归**：Cloud 单测 77/77、Node selftest 42/42、Wrangler dry-run、正式构建、线上 CORS/静态资源验证通过。旧 Node 的 Edge UI 测试 60/61：唯一未过的“暂停在1秒内传到玩家（长轮询）”属遗留 `sync=long` 路径的间歇性延迟，非云版 DO；如需维护 Node 再专项排查，不应将其误记为全绿。正式云端独立 E2E 导入与备份验证通过。
- **待后续**：B 站 BV 自动提取不在 v3.3.4 范围内；用户计划后续单独处理可靠的音频获取渠道，未恢复旧版常驻代理。
# 云端版最新状态（2026-11-23 北京时间）

## 2026-11-23：v3.3.3 二次源码审计、主动探针与房间供源已落实

- **故障再定位**：梅林v3.3.1日志Cloudflare连接分别`needCount=10/17`，对应`forwardedBytes=21,897,470 / 37,225,699`。两者分别精确除以10/17，均为**2,189,747B/次**，等于2,188,046B音频+9帧协议头1,701B。故DO每次请求都已将9帧提交给发送接口，但不能推断浏览器实际收到；Cloudflare官方WS文档明确send()可能在失效连接上不报错而丢消息。梅林的Edge面板WebSocket `reconnects=0`，不说明端到端通路健康。旧接收端30秒超时仅重发need、继续使用readyState=OPEN的同一WS，缺少主动liveness检测，是可证实的恢复策略缺陷；尚未定位梅林本人的唯一根因。
- **真实浏览器补测**：使用日常Chrome隔离测试标签与正式公网DO，实际加载`RelayClient`模块，接收一个程序生成的2,188,046B音频文件，9/9帧、SHA256、OPFS保存均成功（非模拟接收器）；旧测试标签一度重加载导致源端对失效旧peer等待ACK超时，新peer成功收齐，进一步说明不能把曾经OPEN当作持续健康。测试随机房间/音频文件已清理，测试标签已关闭。
- **v3.3.3部署**：Cloudflare Worker `gugu-music-cloud` Version `c228ba2e-a947-40ef-a1b8-9baafb79f817`，Wrangler正式deployment确认100%流量。新增浏览器onmessage入口`rawBinaryMessages/rawBinaryBytes/rawBinaryKind`，协议解析`parsedFrames`，状态机拒收`rejectedFrames/lastRejectReason/duplicateFrames`，超时清空前的`timedOutPartialBytes/Chunks`；Blob有效二进制帧兼容处理。用户主动点击生成诊断时，DO限流(每peer10秒)回显文本ACK及一个256KiB二进制帧，报告`connectionProbe.textAck/binaryAck/elapsedMs`，不泄漏房间ID、密钥或原始音频。不自动周期探测，不凭OPEN断言可用。
- **验收**：Cloud67/67、Node42/42、EdgeUI61/61通过；本地DO手动回显通过；正式公网随机房间文本+256KiB二进制回显通过、两名独立PLAYER并发各2,188,046B+故意丢ACK仍完整SHA256通过；线上6/6 HTTP200+CORS。已在用户日常Chrome重新打开Owlbear `The Cured Tying` GM房间，音乐状态rev6501/playing=true、本地有一首2,188,046B音频(摘要6182290c3c)、WebSocket OPEN、已加载v3.3.3模块；在真实GM房间点对点探针结果textAck=true、binaryAck=true、耗时1577ms。电脑当时接交流电，当前Windows计划交流电空闲睡眠=从不，仍不可保证掉电/断网/用户关闭浏览器后可供源。
- **必须后续梅林本人复测**：让他完整刷新到v3.3.3后生成新诊断；若textAck/binaryAck都false→考虑半开连接/路径失败，若仅binaryAck=false→优先查Cloudflare二进制下行/Edge，若两者true但音频receivedFrames不足且rejectedFrames>0→状态机Bug，若receivedFrames9/verified1而未出声→转至音频/权限层。不要据本机公网E2E通过声称梅林已修复。v3.3.2 `0384c3b8-8837-4f49-9737-5ac579103c83`为上一个可回滚版本。

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
