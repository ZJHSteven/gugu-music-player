import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = () => readFile(new URL("../../public/app.js", import.meta.url), "utf8");

test("云版只保留本地音频上传和开源解析器说明，彻底移除 HTTP 直链导入功能", async () => {
  const app = await appSource();
  assert.match(app, /id="file" type="file"/);
  assert.match(app, /云端版不再自动下载 B 站 \/ YouTube 音频/);
  assert.match(app, /https:\/\/github\.com\/NickvisionApps\/Parabolic\/releases/);
  assert.match(app, /target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(app, /id="direct-url"|id="direct-title"|data-act="add-direct"/);
  assert.doesNotMatch(app, /downloadDirectAudio|addDirectAudio|remote-import\.js/);
  assert.match(app, /切到「添加」，上传本地音频文件/);
  const css = await readFile(new URL("../../public/style.css", import.meta.url), "utf8");
  assert.match(css, /\.import-tip\s*\{[^}]*font-size:\s*13px/);
  assert.match(css, /\.backup-download[^}]*text-decoration:\s*none/);
});

test("旧 Node 的 BV 入口保留兼容，但云端隐藏且不会发起 B站 API 请求", async () => {
  const app = await appSource();
  const start = app.indexOf("function addBilibili() {");
  const end = app.indexOf("\nfunction activeFolder()", start);
  assert.ok(start >= 0 && end > start);
  const body = app.slice(start, end);
  assert.match(body, /暂不支持/);
  assert.ok(app.includes('${!window.BARD_CLOUD ? `'));
  assert.ok(app.indexOf('${!window.BARD_CLOUD ? `') < app.indexOf('id="bili"'));
  const cloudPart = body.split("if (window.BARD_CLOUD) {")[1]?.split("if (S.busy)")[0];
  assert.ok(cloudPart);
  assert.match(cloudPart, /toast\(/);
  assert.match(cloudPart, /return;/);
  assert.doesNotMatch(cloudPart, /fetch\s*\(|apiPost\s*\(|uploadTrack\s*\(/);
  assert.doesNotMatch(app, /\/api\/bilibili\/(?:resolve|audio)/);
});

test("GM 歌单允许重命名和逐首补传，缺失原文件提示不会拦截其他歌曲", async () => {
  const app = await appSource();
  assert.match(app, /data-act="\$\{editing \? "rename-save" : "rename"\}"/);
  assert.match(app, /data-act="repair"/);
  assert.match(app, /data-repair-id/);
  assert.match(app, /describeLocalAudio/);
  assert.match(app, /sort-handle/);
  assert.match(app, /cloud\.onHealth\(/);
  assert.match(app, /class="btn block primary backup-download"/);
  assert.doesNotMatch(app, /房间同步不发送服务器心跳/);
});

test("Worker 只做 DO 按需中继，不存在云端抓取或常驻闹钟", async () => {
  const worker = await readFile(new URL("../../cloud-worker/index.js", import.meta.url), "utf8");
  const wrangler = JSON.parse(await readFile(new URL("../../wrangler.jsonc", import.meta.url), "utf8"));
  assert.doesNotMatch(worker, /handleBiliGateway|api\.bilibili|\/api\/bilibili\//);
  assert.doesNotMatch(worker, /setInterval\s*\(|setTimeout\s*\(|setAlarm\s*\(|fetch\s*\(\s*["']https:/);
  assert.match(worker, /this\.ctx\.acceptWebSocket\(server\)/);
  assert.match(worker, /serializeAttachment/);
  assert.deepEqual(wrangler.assets.run_worker_first, ["/relay"]);
});

test("诊断只在设置页按需展示，歌单页不展示大型日志", async () => {
  const app = await appSource();
  assert.match(app, /settingsView\(\) \+ diagnosticsView\(\)/);
  assert.match(app, /function playerSettingsView\(\)/);
  assert.doesNotMatch(app, /\(S\.role === "GM" \? gmView\(\) : playerView\(\)\) \+ diagnosticsView\(\)/);
});
