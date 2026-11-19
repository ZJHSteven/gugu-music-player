# iPhone v3.2.5：修复播放器权限，但不交出同步控制权

## 决策

**撤销 v3.2.4 的「Safari 原生 audio controls 兜底」作为正式播放方案。**
原生进度条允许 PLAYER 本地改变歌曲时间，与咕咕「GM 一人控制、
玩家共享同一播放时间轴」的架构冲突。即使那条路径能获得 Safari 用户
点击权限，也不能以破坏房间同步为代价交付。

v3.2.5 从已部署 v3.2.4 热修复分支单独切出，保留原有的
Cloudflare DO 音频中继、SHА-256 缓存校验、MIME 文件头识别和诊断。
它不擅自发布尚未完整验收的 v3.3.0 长期功能。

## iPhone Safari 为什么 PLAYER 点击「开启声音」可能仍失败？

原先播放实际在 Owlbear 的背景 iframe 里运行，面板的点击只通过
BroadcastChannel 给后台传递一条普通 JSON 指令。Safari 在后台调用
`audio.play()` 时，不一定收到用户激活许可，于是可能抛出
`NotAllowedError`。GM 点击暂停／继续并不意味着 GM 有特殊解码权限：
当时可能恰好启动了浮窗内的备用 Engine，或者旧音频元素已获得授权，
也可能是加载时序变了。当前缺少当时 GM 的播放器位置和内部身份状态，
不能反推那次的唯一根因。

WebKit 文档建议在用户点击时直接对真正的音频元素执行 `play()`，
并且同一媒体元素尽量在换曲时继续复用：
https://webkit.org/blog/7734/auto-play-policy-changes-for-macos/

Owlbear 自定义扩展的 manifest 之前已经声明了 `autoplay` 权限，
并非漏掉此项：https://docs.owlbear.rodeo/extensions/reference/manifest/

## 修改

- 弹窗里预先创建单一 `Audio` 元素（`controls=false`），按曲目
  SHA256 预先从 OPFS 读取，并使用 v3.2.4 的 MIME 恢复模块准备 Blob。
- GM 和 PLAYER 都只能点击「开启并同步房间声音」，该按钮同步执行
  **本 iframe 音频元素的 `play()`**，中间无 `await`，不会经跨
  iframe BroadcastChannel 传递用户激活。
- 音频真正成功播放才通知后台引擎暂停，防止双路叠音；若 Safari
  仍拒绝，不停后台、不谎报已经获得权限。
- 不提供原生音频控件，PLAYER 无法在本地手动暂停或 seek；GM 的
  暂停／继续／seek／切歌经房间元数据变化传来。
- 播放目标始终由 GM 的绝对 `playback.anchor` 与 `position`
  计算；单曲循环只是媒体解码器的执行机制，不改写下一轮绝对锚点。
- 平时在 100ms 误差容忍区保持原速；超出时最多 ±1.5% 的轻微追钟；
  持续 6 秒大偏差才允许限频恢复；GM 显式 seq 变化立即 seek。
- 诊断增加 `iosSynchronizedPlayback` 白名单字段，可分清
  前台/后台两个不同播放器的播放拒绝、音频位置和时钟误差。

## 验收边界

已测试：纯 JS 逻辑和 Chrome（通过自定义 iPhone UA 驱动真实页面）
的 PLAYER UI，PLAYER 音频没有任何 controls，点击即可播放，
另一 GM 标签页暂停后本机跟随暂停、继续后恢复，亦有错误拒绝时
不停止背景的测试。

**仍需真实 iPhone Safari/QQ WebKit 的音频输出和面板收起测试**。
关闭 Owlbear 的可见浮窗可能销毁此 iframe。届时会尝试把输出交回
宿主后台 iframe，但 Safari 的用户激活策略不保证它可以接着发声。
此限制不能用自定义 JS 「模拟点击」绕过。若真实 iPhone 测试确认
闭合面板不能继续播放，下一项研究是给 iOS 提供一个长期存活的
受 GM 时间表控制、没有 PLAYER 进度条的音频会话承载页面，而不是
重新暴露本地控制权。
