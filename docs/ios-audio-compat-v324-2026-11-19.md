# 2026-11-19：iOS Safari / QQ 内置浏览器媒体兼容热修复 v3.2.4

## 真实故障样本

用户同一 iPhone 在 QQ 内嵌浏览器和 Safari 独立版中，访问其他 GM 的实际 Owlbear 房间，报告：

- 同一音轨 `a2cb557e7a…`，文件大小 **8,872,436 字节**，时长 554.456417 秒；
- DO 真实转发成功，客户端按原始 SHA-256 校验成功，缓存 owned=1、filesVerified=1；
- QQ 浏览器：HTMLAudioElement `MEDIA_ERR_SRC_NOT_SUPPORTED=4`，`play()` 拒绝 `NotSupportedError`；
- Safari：同样 `MEDIA_ERR_SRC_NOT_SUPPORTED=4`，多次 `play()` 拒绝 `NotAllowedError`，并且「开启声音」按钮无效。

因此并不是网络分片丢失；媒体源识别和 iOS 用户激活权限是两个分别需要检查的层次。**无法在没有拿到音轨原始媒体头/编码的情况下保证 Safari 一定支持这首歌。**

## v3.2.4 修复范围

仅从已上线的生产 `v3.2.3` 热修复分支创建，严格不混入尚未验证的 v3.3.0 预测歌单、时钟闭环、GM 升权、DO 歌单快照与备份功能：

1. `audio-source.js`：从原始文件头识别 MP3/WAV/MP4/Ogg/FLAC/WebM/AAC/AIFF，按照识别结果或明确的房间元数据 MIME 重建带 `Blob.type` 的媒体源，不改变音频字节；本地仍使用原 SHA-256 去重。
2. Owlbear `publicNow` 的曲目对象保留 `mime`，以便客户端从 OPFS 无后缀的文件名恢复真实媒体类型。
3. `engine.js` 的播放器经 `playableAudioSource` 后才创建 Blob URL，诊断中新增识别 MIME、OPFS 源 MIME 与 `canPlayType`。媒体错误 4 提示为格式／媒体源问题。
4. iOS 的 PLAYER 可在面板选择「iPhone 无声？使用原生播放器」；被阻止时按「开启声音」也会引导显示原生控件。实际声音需要用户**再次亲自点击可见原生控件中的播放按钮**，不依赖跨 iframe `BroadcastChannel` 传递用户激活权限。弹窗关闭可能中断，属于应急兼容路径而非最终的后台音频方案。
5. 使用这个原生控件时暂时抑制后台音频元素，以免设备发出重音；关闭原生控件后恢复后台播放器尝试。

## 验收

- 纯函数单测：OPFS/File.type 为空的 MP3 可恢复 `audio/mpeg`，字节逐字节不变；M4A/Ogg 等按文件头保留真实格式。
- 云版 Node 端：**16/16** 通过；原 Node 服务 **42/42**；Edge UI **61/61**；静态构建和清单预检通过。
- *没有在 iOS 真机上完成播放恢复验收*，不能据上述测试宣称 Safari 或 QQ WebView 已真正播放成功。
- 诊断报告有时间戳、媒体错误类型、`canPlayType` 值；不包含房间密钥、音频字节、歌曲标题。

## iPhone 复测

刷新所在 Owlbear 房间，打开咕咕点歌台 PLAYER 面板：

1. 先观察普通背景播放器是否直接能发声；
2. 若仍无声，点击「iPhone 无声？使用原生播放器」，在出现的系统音频控件上**再次点击播放键**；
3. 如果依然出现错误 4，复制播放诊断；请同时确认房主上传的是 MP3 / M4A AAC 而非 iOS 不能解码的其他编码。

将来的正式方案需使音频输出固定在能够获得用户手势的常驻 iframe，进一步验证 Safari 后台策略，不能把一次用户点击视为跨 iframe、跨页面的万能音频授权。
