# 咕咕点歌台 · Cloudflare 云版执行计划

## 2026-11-20：梅林 Edge 无痕玩家没有音乐会话（v3.2.8 独立生产热修复）

- 新证据：梅林 GM 与匿名 PLAYER 在 10:39 两份诊断均为生产 v3.2.7；GM rev8、270.84秒音频当前正在播放，PLAYER `hasMusicSession=false` 且两条 relay=null。故障早于音频下载，绝不通过加大音频缓存或放开 autoplay 解决。
- 现有 3.2.7 代码有确定的缺陷链：SDK `waitReady()` 超时仍继续、`detectRole()` 失败默认为 PLAYER、`roomId` 为空跳过 CloudBridge；首次 `getMetadata()` 无状态也没有有界补偿重读。真实报告缺少 sdkReady / roomIdPresent，不能认定哪一步命中。
- 从已测试的 v3.3 只回移严格 SDK 就绪与角色/房间 ID 校验、两次有界启动恢复、无状态时有界元数据重读，**不携带** v3.3 时间轴、16KiB 快照/备份等未上线改造。
- 诊断里记录匿名 SDK 就绪、房间 ID 是否存在、后台引擎应答和本地音乐状态读取情况；若仍不能读到，显式显示故障而不是伪装成没歌或没下载。不允许打印用户真实 roomId、token 或原始 SDK 异常。
- 自动化必须覆盖：SDK ready/role/room 缺失、重试上限、后期元数据出现自动恢复、正常 GM/PLAYER 读状态且不触动 DO 音频协议；跑全量云版/Node/UI，云端部署单独验收，梅林实际无痕窗口仍需复测。

## 2026-11-20 · iOS Chrome 隐私模式接收失败及被裁切的滚动面板

本轮只在正式 v3.2.6 的独立热修复分支修改，不混入 v3.3.0 的 SDK/时间轴/备份开发。

1. 客户端在报告里接收 2,188,046 B、9/9 块，但 verified=0、errorName=Error；确认失败是完整收包后的校验或写入，不能简单归咎于网络或播放授权。增加安全的 `failurePhase` / `failureReason` 诊断，不记录完整音频摘要和个人信息。
2. OPFS 和 IndexedDB 同时不可写时，已通过 SHA-256 的音频可回退到**单个 iframe 进程内有大小上限的临时内存**，不冒充永久缓存；记录实际保存后端。需要证明刷新后不能依赖此副本，后台/弹窗不能凭广播虚报拥有不存在的副本。
3. 纠正 iOS Chrome 被报告为 Safari，以及 v3.2.6 报告仍写死 v3.2.5 的版本不一致。构建清单与诊断共用版本来源。
4. 当 Owlbear iPhone 宿主裁切名义 640px 高的 iframe，内部 100dvh 依然可能过高；为窄屏触控设备设置保守、真实可滚动的内部面板高度，验证矮视口与诊断长内容。
5. 全量回归 Cloud/Node/UI、隔离浏览器交互与生产版本校验；未做 iPhone WebKit 真机复测时，不能宣布平台故障彻底解决。

## 目标

在不重新设计界面的前提下，让点歌台在 Owlbear Rodeo 内从任意平台使用，不依赖本地 Node、Quick Tunnel 或中心化音频文件库。

## 设计

1. 使用 Workers Static Assets 发布当前 `public/` 网页与 Owlbear manifest，运行时仅经 `/relay` 建立 WebSocket。
2. 房间歌单、设置与播放状态保存在 OBR Room Metadata（16 KB **总限制**），播放变化通过 OBR Broadcast 加速；DO **不参与**播放同步。
3. 用户选中的文件写入同源 OPFS，必要时回退 IndexedDB；曲目使用 SHA-256 内容寻址，校验一致后才加入可用副本。
4. 每个 Owlbear 房间使用 128 位随机 capability 将 DO 地址隔离；DO 只保留 WebSocket 附件中的节点身份与拥有的摘要，不进行音频持久化。
5. 256 KiB 单块，通过二进制 WebSocket 单跳转发，按需发送，有背压及哈希校验；无应用层心跳与定时轮询。
6. 前端仍保留原有 GM/玩家视图、分类、控制条与后台音频引擎；云版代码用条件分支，不破坏原 Node/Electron 版。

## 现实约束

- 原版音乐同步走 Node SSE/HTTP，因此需要改造，而不是只替换 URL。
- 浏览器可以驱逐 OPFS/IndexedDB；`navigator.storage.persist()` 只能申请持久化，并不能保证用户清理数据时留存。
- Owlbear 元数据容量有限；过长歌单需要用户分组/清单导出，首版明确拒绝超额并显示错误。
- WebKit iOS 背景页与音频自动播放受系统政策限制，必须在真实 Owlbear 房间测试。
- Bilibili 原版依赖 Node 服务代理、抓取和转发，纯云版若未开发等价提取端点不能宣称该功能可用。
- 浏览器端角色信息不等于可信的服务器端身份凭据。capability 可避免猜房间 ID，但不能防范房间内恶意成员。

## 验收清单

- [x] 新云版代码、构建与自动化测试
- [x] 本地 30 MiB 文件完整性与 GM 离开后玩家间传输
- [x] 浏览器跨独立存储环境 3 MiB 中继、OPFS 完整性校验
- [x] 假 Owlbear SDK 下 GM/PLAYER 房间事件、控制指令、权限和独立浏览器文件同步（2026-11-19）
- [x] 真实 Owlbear 源跨域读取云版 v3.2.1 manifest（CORS / 绝对 URL 检验）
- [x] Owlbear 账户安装云版自定义扩展
- [x] 在用户现有 The Cured Tying 房间启用扩展（从官方 Profile → Edit Room 入口启用，绕过宿主扩展列表骨架卡）
- [ ] 公网 30 MiB 文件、复杂断线与多设备重传
- [ ] IndexedDB 后备、iOS/Safari 存储驱逐与后台声音真机验收
- [x] 纯静态文件 + hibernatable DO 无 HTTP Node API 依赖
- [x] Workers 上线和域名验证
- [x] Owlbear 真实 GM + 两名独立访客进入同房间，房主批准、SDK 元数据和广播、歌单传输、控制权限、暂停与拖动、按时自动切歌
- [x] 真实 Cloudflare DO GM→玩家、关闭 GM 中继时玩家 A→玩家 B 文件分发；两段 WAV 完整校验；重新加载后 OPFS 缓存复用
- [x] 修复隐藏 Owlbear iframe 首次渲染卡死、时钟超出曲长、同源双 iframe 重复文件请求
- [ ] 浏览器解除自动播放限制后验证实际扬声器发声（当前锁屏/隐藏页被 Chrome 拒绝自动播放），以及手机 iOS/Firefox/Android 真机
