# 咕咕点歌台云端版 · 安装与测试

## 在线入口

- Owlbear 插件清单：`https://music.zjhstudio.com/manifest.json`
- 网页入口：`https://music.zjhstudio.com/`
- Cloudflare Worker：`gugu-music-cloud`

将 **插件清单完整 URL** 添加为 Owlbear Rodeo 自定义扩展，再在房间打开咕咕点歌台。
GM 将本地音频拖入“添加”页，音频优先保存到当前浏览器 OPFS，
其他玩家在缺少该文件时通过同一房间的可休眠 DO WebSocket 获取。
曲目和播放/暂停状态由 Owlbear Room Metadata/Broadcast 同步。

**重要：** 房主在当前设备原始歌曲清理前务必另行保存离线备份！
浏览器可能自动删除站点存储、用户也可能主动清理缓存；任何成员都不在线时，
**DO 没有任何音频备份可供恢复**。文件分发只在至少有一个在线持有者时成功。

## 平台和版本范围

| 项目 | 当前状态 |
|---|---|
| Windows / macOS Chrome、Edge、Firefox | 设计支持 OPFS，失败回退 IndexedDB；未全部真机逐端验收 |
| iOS / Android Safari、Firefox、Chromium | 设计适配；后台页面与音频自动播放还需真机验收 |
| 浏览器内直接上传歌曲、歌单分类、播放控制 | 云版已实现 |
| B 站链接抓取、在线音频提取 | 原版依赖 Node，纯云版暂不可用 |
| 文件分块、哈希、自动按需获取 | 已实现；浏览器隔离环境 3 MiB 和本地 DO 30 MiB 测试通过 |
| DO 休眠 | 使用 `ctx.acceptWebSocket()`，不设 DO 内定时器，等待 Cloudflare Runtime 决定休眠 |

## 开发验证

```pwsh
npm ci
npm run test:cloud
npm run build:cloud
npx wrangler dev --local --port 8790
```

启动另一个终端进行真实本地 DO 中继测试：

```pwsh
$env:GUGU_RELAY_URL = 'ws://127.0.0.1:8790/relay'
node tests/cloud/relay-smoke.mjs
```

在浏览器打开以下地址，模拟 GM 和玩家（`dev=1` 仅模拟 SDK）：

- `http://127.0.0.1:8790/?dev=1&role=GM&room=test-123`
- `http://127.0.0.1:8790/?dev=1&role=PLAYER&room=test-123`

网页会使用相同的测试房间元数据；也可以用 CDP 独立 BrowserContext
模拟不同设备的存储隔离，验证实际走 DO 同步音频而非共享一个浏览器缓存。

部署：
```pwsh
npm run deploy:cloud
```

部署前请先确认当前 Cloudflare 账号、域名和 wrangler 配置，不要误部署到其他账号。

## 成本与传输边界

Cloudflare Worker 只负责静态文件与连接升级。每房间一个 DO 实例，
每个已打开网页占一个 hibernatable WebSocket；闲置无音频传输时无持续
音频流、无周期应用心跳。DO 的握手、入站消息及运行期间仍可能计费，
休眠期间不累计计算时长费用。

当前每个块 256 KiB，最大单音频 64 MiB。文件只有在本地完整校验后才写入
OPFS/IndexedDB。本地空间不够、无在线副本或网络断开均可能导致歌曲不能播放。
