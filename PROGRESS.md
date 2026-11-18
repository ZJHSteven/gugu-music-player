# 云托管分支进展

## 当前结论

- 本分支独立于 `feat/electron-macos-launcher`，从上游同版本的 Fork `main` 创建。
- 原版通过 Node/SSE 同步歌曲与播放位置，不能只替换音频 URL；已确定迁移为 Owlbear Room Metadata/Broadcast。
- 官方约束：room metadata 总计 16 KB、broadcast 消息 16 KB、Cloudflare DO 输入 WS 消息 32 MiB；选择 256 KiB 块与 SHA-256 校验。
- 正在实现纯云端架构；尚未完成真正房间 E2E/正式上线。

## 关键设计

- DO 只中转短暂的文件流，不运行音乐时间轴，不存音频，不设服务器定时心跳。
- 每个浏览器存副本，只有缺失时才从在线节点请求；新玩家加入时不要求 GM 在线。
- 网页优先 OPFS，后备 IndexedDB，用户自行负责额外离线备份。

## 后续

- 完善协议测试、多端测试、浏览器测试，验证域名与部署。
