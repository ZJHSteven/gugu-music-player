# 咕咕点歌台：2026-11-19 真实 Owlbear Rodeo 三客户端 E2E 验收

## 环境与隔离

- 正式平台：Owlbear Rodeo 房间 **The Cured Tying**，原有 GM 登录账号及其日常 CDP Chrome；插件 v3.2.1，地址 https://music.zjhstudio.com/manifest.json。
- 另建立两个独立的 Chrome BrowserContext，不共享登录信息及 OPFS，分别以访客 **Gugu E2E Test Player**（A）、**Gugu QA Peer B**（B）请求加入；GM 在原始房间通过官方 **ADMIT** 批准。
- 只启用咕咕点歌台，不修改场景、Token 和其他扩展。插件通过 Owlbear 账户的 **Profile → Edit Room** 正常启用。
- Cloudflare Workers Static Assets 提供网页资源；Durable Object 的 WebSocket 只转发缺失的二进制文件；房间播放状态通过真实 Owlbear SDK Room Metadata / Broadcast 同步。

## 已确认成功的实际操作

| 场景 | 实测结果 |
| --- | --- |
| 正式安装 | 修复 CORS 和相对路径尾点问题；Owlbear 页面能跨域获取 manifest、图标和 iframe。 |
| 角色与 SDK | GM 与 A/B 各自 `getRole()` 返回 GM/PLAYER，同一 roomId，后台与弹窗均连接到 DO。 |
| 隐藏页面渲染 | 原隐藏 iframe 的 `requestAnimationFrame` 不执行导致「正在连接…」；改一次性定时器兜底后能显示 GM/玩家界面。 |
| GM → A | 上传 WAV：20 秒、8 kHz、单声道，320044 字节，摘要 `f8a1933a3e4a77f7217b5c29e18f9fd9da93faf0c1b1b117b93330db9c95cd3c`。A 面板及后台均收到房间 rev2 和变更广播；通过生产 DO 获得字节，SHA-256 完全一致。 |
| GM 控制与玩家权限 | PLAYER 直接发 pause 命令明确遭拒，修订号不变。GM 暂停、设 5.75 秒进度、恢复，玩家同样出现已暂停/恢复，进度相符。 |
| 自动结束 | GM 后台因缺用户交互被 Chrome `NotAllowedError` 禁播；原时钟越过 20 秒后卡住。增加 GM 原有 500ms 本地 tick 的到时切换及 `expectedSeq` 去重，正式房间的修订号多次约间隔 20 秒增长，进度回到 0，没有新增 DO 心跳。 |
| A 退出重进 | 重新加载访客页面后仍为 PLAYER，自动恢复 rev12，320044 字节 OPFS 文件与 SHA-256 匹配，下载队列无需重复传输。浏览器 `storage.persisted()` 返回 false，**不能承诺长期存储绝不被驱逐**。 |
| GM 中继下线，A → B | 测试时只关闭 GM 的两条 RelayClient WebSocket（没有离开房间），B 加入后从已缓存的 A 经生产 DO 中继获得完整 320044 字节文件，SHA-256 一致。GM 中继随后恢复并确认在线。 |
| 同源后台与面板共享 | 新增 BroadcastChannel 缓存通知，再上传不同的 WAV：17 秒、660 Hz、272044 字节，摘要 `018634a1c531f2afb9f22395539fe7da43205de30caa6efbcaefb3a1a6b1f895`。A/B 面板和后台均收到同源 `saved` 信号、更新到 rev13，`owned=2`、`requested=0`；不再维持旧的 30 秒重复请求。 |
| 清理 | GM 从歌单按具体 ID 删除两首测试歌曲，rev15、歌单 0、已停止，A/B 同步一致；其他扩展 Metadata 键未改变。两个访客 BrowserContext 和临时 Profile 标签页均关闭。GM 原站点 OPFS 对应两首测试 WAV 也已删除。原有真实房间与已启用咕咕扩展保留。 |

## 回归与限制

- 自动化回归：`npm run test:cloud` **11/11**；`npm run selftest` **42/42**；`npm run uitest` **61/61**；`npm run build:cloud` 与 `npm run verify:cloud` 通过。
- 音频文件不仅有哈希校验，GM 和玩家的浏览器还能通过 `OfflineAudioContext.decodeAudioData()` 将 440 Hz 测试 WAV 正确解码为 **20 秒、8 kHz、单声道**。
- **实际扬声器发声尚未通过验收**：Windows 当前环境显示锁屏／后台隐藏，GM 的 `HTMLMediaElement.play()` 被 Chrome 以 `NotAllowedError` 拒绝；此限制不能由元数据同步通过替代。需要用户在可交互的浏览器中手动解锁声音后现场确认。
- **尚未验证**：公网 30 MiB 单文件长连接、Safari/iOS 与 Firefox/Android 音频后台策略、OPFS 被驱逐后的 IndexedDB 回退；云版 B 站曲目抓取仍未迁移。
- 本测试仅说明已验证的多浏览器控制、分发、缓存与时钟行为；不宣称浏览器隐私设置不可绕过、真实音频已扬声器播放，或永久存储不会被清理。
