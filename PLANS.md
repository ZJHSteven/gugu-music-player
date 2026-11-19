# 咕咕点歌台 · Cloudflare 云版执行计划

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

### 2026-11-19 P40 手机与桌面同步专项

- [x] P40（ELS-AN00）ADB 在线，官方 Mozilla Firefox Android 160.0.1 ARM64 已安装
- [x] 识别原双 GM 缺陷：相同 Owlbear GM 身份并不代表同一设备时钟
- [x] 同一房间双 GM 改为按设备级 clockId 指定唯一计时权威，跨设备提交控制命令时转换锚点
- [x] 12.4 秒单曲循环不再在循环边界硬跳；背景时钟节流数圈后可恢复正确相位
- [x] 云版连续播放温和纠偏（±1.5%）、仅持久大偏差限频 seek，不再每 3 秒硬跳
- [x] 迟到玩家优先获取正在播放的歌曲，其他曲目最多并行预取一首
- [x] 自行保存完整歌单 ZIP + 原音频的备份/恢复代码及入口（待正式房间 UI 验收）
- [ ] P40 Firefox 首次进入 Owlbear 房间并完成 USB Remote Debugging（锁屏尚未解除）
- [ ] P40 音频解码/出声/播放 12 秒短曲连续性、与 Windows 的长期同步、双 GM 实机控制
- [ ] Safari/iPhone 同类实机验证，30 MiB 公网音频传输、Range 分片流式播放

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
