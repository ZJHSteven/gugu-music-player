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

- [ ] 新云版代码、构建与自动化测试
- [ ] 30 MiB 文件的完整性、断线重传与两玩家同步
- [ ] OPFS / IndexedDB 后备与存储清理提示
- [ ] 纯静态文件 + hibernatable DO 无 HTTP Node API 依赖
- [ ] Workers 上线和域名验证
- [ ] Owlbear 实际房间多端播放验证
