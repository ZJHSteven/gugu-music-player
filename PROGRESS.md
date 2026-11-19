# 云端版当前状态（2026-11-18）

## 当前结论

- **已上线首版**：Cloudflare Worker `gugu-music-cloud` + 自定义域名 `https://music.zjhstudio.com`，可通过 `/manifest.json` 安装 Owlbear 插件。
- 开发分支 `feat/cloud-do-opfs`，独立于原 Electron QA 分支及上游原版。
- 原版靠 Node/SSE/HTTP 管理播放；云版已用 Owlbear Room Metadata/Broadcast 替代，保留原 UI。
- 云版只把音频放在玩家的 OPFS/IndexedDB；Cloudflare Durable Object 仅经可休眠 WebSocket 中继二进制文件，不储存歌曲、不处理播放指令、不发心跳。
- 当前已验证：状态机/二进制单元测试 10/10；原版 Node 服务测试 42/42、Edge UI 回归 61/61；本地真实 DO 的 2 MiB 与 30 MiB、GM 下线后玩家中继；Chrome 双标签 GM/玩家同步；独立无痕浏览器 OPFS 获取缺失的 32 KiB 与 3 MiB 文件，哈希正确。
- 最新生产测试：HTTPS 200、manifest 正常，更新后的 8 块 ACK 窗口版 `46f93e83-ae8d-4bb4-9ae3-268f70687ae3` 已部署；公网 1 MiB 9.8s、GM 离线后玩家间 4 MiB 27.5s，均完成 SHA-256 校验。30 MiB 公网测试此前中途停止，尚无通过结论。
- GitHub 已同步开发分支 `ZJHSteven/gugu-music-player:feat/cloud-do-opfs`；没有合入上游主线或覆盖原 Electron QA 分支。

## 技术约束

- 房间元数据总限 16 KB，云版主动使用约 14 KB 安全上限；超过上限拒绝写入并提示减小歌单。
- WebSocket 每 256 KiB 一块、8 块一个 ACK 窗口，浏览器侧 30 秒断流重试（**非 DO 心跳**），整文件完成后 SHA-256 校验。
- 手机 Safari/iOS 等后台音频与存储驱逐仍需真机验证；`navigator.storage.persist()` 不保证永久保存。
- 浏览器版未实现上游 Node 所依赖的 B 站视频抓取转音频入口，云版前端已暂时隐藏该输入；现阶段仅对本地上传音频功能完成云端迁移。
- `?dev=1` 的模拟 SDK 可跨同源标签模拟 Owlbear 房间，但不能代替 Owlbear 正式房间验收。
- Edge UI 测试偶发 `chrome-extension://abkclgdmdkokpdkbpdkoiiemhcaafbkg` 注入脚本异常，已保留详细异常记录，并只将可明确归属外部扩展的错误排除；最终原版 61/61 通过。

## 下一步

- 2026-11-19 真实 Owlbear CDP 验收发现首个安装阻塞：Owlbear 页面跨域 fetch 云版 manifest 触发 CORS，已在云版构建工具中为公开静态资源生成 `_headers`，待部署后重验。假 SDK GM/玩家跨标签事件、权限拒绝与独立浏览器 320044 字节文件 SHA256 校验通过。
- CORS 修复已部署（64fa7750），真实 Owlbear 添加自定义插件的弹窗已经能够读取并展示完整 manifest。进一步观察到宿主将相对图标 URL `./icon.png` 拼成了带尾点主机名的异常路径；云版改为绝对 HTTPS manifest 资源地址（v3.2.1），待重新发布重试。当前 Owlbear 扩展列表仍显示大量骨架屏，部分宿主 API 请求异常，不能把“已点击 ADD”当作房间扩展启用成功。

1. 真实 Owlbear 房间内核对 GM/玩家加入、切歌、自动播放限制、移动端后台与断线恢复。
2. 进行公网 30 MiB 大文件长时间下载验收，区分本地快与公网慢的瓶颈；并为超时重试添加客户端可见进度。
3. 视需求增加房主歌曲备份的显式导入/导出，以及替换 B 站提取的合规云端方案。
