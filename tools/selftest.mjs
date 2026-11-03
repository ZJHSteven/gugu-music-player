// 服务端端到端自检：在进程内拉起服务器，跑真实 HTTP 流程。
// 运行：node tools/selftest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8799;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "bard-test-"));
process.env.PORT = String(PORT);
process.env.DATA_DIR = DATA;

const BASE = `http://127.0.0.1:${PORT}`;
const ROOM = "testroom1";

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try {
    const r = fn();
    // 异步回调会"先返回 Promise"，断言其实没跑就记为通过——这里直接拦住
    if (r && typeof r.then === "function") throw new Error("check 回调不能是 async：请先 await 取值，再同步断言");
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail++;
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
};

/** 静音 WAV 素材。 */
function wav(seconds = 1, rate = 8000) {
  const n = seconds * rate;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  return b;
}

const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.chdir(ROOT);
await import(pathToFileURL(path.join(ROOT, "server/index.js")).href);
await sleep(400);

console.log("\n[1] 基础");
const health = await json(await fetch(`${BASE}/api/health`));
check("health 正常且带服务器时间", () => {
  assert.equal(health.status, 200);
  assert.ok(Math.abs(health.body.time - Date.now()) < 5000);
});

const manifest = await json(await fetch(`${BASE}/manifest.json`));
check("manifest 可被 OBR 读取", () => {
  assert.equal(manifest.body.manifest_version, 1);
  // 用相对路径：根路径托管（本机）和 GitHub Pages 子路径托管都能用
  assert.equal(manifest.body.action.popover, "./");
  assert.equal(manifest.body.background_url, "./background.html");
  assert.equal(manifest.body.icon, "./icon.png");
  // 边栏按钮用单色简化版（OBR 会对它做单色遮罩）
  assert.equal(manifest.body.action.icon, "./icon-action.svg");
  assert.ok(fs.existsSync(path.join(ROOT, "public/icon.png")));
  assert.ok(manifest.body.name.length <= 45);
  assert.equal(manifest.body.author, "鸽翅");
});

check("前端资源没有根路径引用（GitHub Pages 子路径可用）", () => {
  for (const f of ["public/index.html", "public/background.html"]) {
    const html = fs.readFileSync(path.join(ROOT, f), "utf8");
    const bad = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(bad, [], `${f} 里还有：${bad.join(", ")}`);
  }
});

check("部署配置 config.js 存在", () => {
  assert.ok(fs.existsSync(path.join(ROOT, "public/config.js")));
});

console.log("\n[2] SDK 依赖必须本地化（OBR 里 404 的根因）");
const sdkSrc = fs.readFileSync(path.join(ROOT, "public/sdk/obr.js"), "utf8");
check("SDK 里没有 /npm/ 绝对路径依赖", () => {
  const abs = [...sdkSrc.matchAll(/from\s*["'](\/npm\/[^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(abs, [], `仍有：${abs.join(", ")}`);
});
check("SDK 依赖文件齐全", () => {
  for (const f of ["uuid-9.0.1.js", "immer-10.1.1.js", "js-base64-3.7.7.js"]) {
    assert.ok(fs.existsSync(path.join(ROOT, "public/sdk/vendor", f)), `缺 ${f}`);
  }
});

console.log("\n[3] 主持权");
const gm = await json(
  await fetch(`${BASE}/api/rooms/${ROOM}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: "gm-1", name: "地下城主" }),
  })
);
check("GM 能取得控制权", () => {
  assert.equal(gm.status, 200);
  assert.ok(gm.body.token.length > 20);
});
const gmToken = gm.body.token;

const second = await json(
  await fetch(`${BASE}/api/rooms/${ROOM}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: "gm-2", name: "另一个GM" }),
  })
);
check("主持在线时别人抢不走（423）", () => assert.equal(second.status, 423));

const noToken = await json(await fetch(`${BASE}/api/rooms/${ROOM}/state`));
check("无令牌读完整歌单被拒（403）", () => assert.equal(noToken.status, 403));

console.log("\n[4] 上传与分发");
const wavBuf = wav(1);
const up = await json(
  await fetch(`${BASE}/api/rooms/${ROOM}/tracks?name=${encodeURIComponent("测试曲目.wav")}&duration=1`, {
    method: "POST",
    headers: { Authorization: `Bearer ${gmToken}` },
    body: wavBuf,
  })
);
check("上传本地音频成功", () => {
  assert.equal(up.status, 200);
  assert.equal(up.body.track.title, "测试曲目");
  assert.equal(up.body.track.size, wavBuf.length);
});
const trackId = up.body.track.id;

const anonUp = await fetch(`${BASE}/api/rooms/${ROOM}/tracks?name=x.wav`, { method: "POST", body: wavBuf });
check("无令牌上传被拒（403）", () => assert.equal(anonUp.status, 403));

const bad = await fetch(`${BASE}/api/rooms/${ROOM}/tracks?name=${encodeURIComponent("坏.html")}`, {
  method: "POST",
  headers: { Authorization: `Bearer ${gmToken}` },
  body: "<script>",
});
check("非音频被拒（415）", () => assert.equal(bad.status, 415));

const audioUrl = `${BASE}/audio/${ROOM}/${trackId}`;
const full = await fetch(audioUrl);
const fullBuf = Buffer.from(await full.arrayBuffer());
check("音频字节与原文件一致", () => {
  assert.equal(full.status, 200);
  assert.equal(fullBuf.length, wavBuf.length);
  assert.equal(fullBuf.subarray(0, 4).toString(), "RIFF");
});

const part = await fetch(audioUrl, { headers: { Range: "bytes=100-199" } });
const partBuf = Buffer.from(await part.arrayBuffer());
check("Range 返回 206 且片段正确", () => {
  assert.equal(part.status, 206);
  assert.equal(partBuf.length, 100);
  assert.match(part.headers.get("content-range"), /^bytes 100-199\//);
});

console.log("\n[5] 播放控制");
const cmd = (body, token = gmToken) =>
  fetch(`${BASE}/api/rooms/${ROOM}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }).then(json);

const sel = await cmd({ type: "select", trackId });
check("GM 选曲成功", () => assert.equal(sel.status, 200));

const now = await json(await fetch(`${BASE}/api/rooms/${ROOM}/now`));
check("now 返回正在播放的曲目", () => {
  assert.equal(now.body.track.id, trackId);
  assert.equal(now.body.playback.playing, true);
});
check("now 不含歌单（玩家看不到）", () => {
  assert.equal(now.body.playlist, undefined);
  assert.equal(now.body.settings, undefined);
});

const fake = await cmd({ type: "pause" }, "deadbeef");
check("伪造令牌被拒（403）", () => assert.equal(fake.status, 403));

const anon = await json(
  await fetch(`${BASE}/api/rooms/${ROOM}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "pause" }),
  })
);
check("玩家直接调指令接口被拒（403）", () => assert.equal(anon.status, 403));

await cmd({ type: "seek", position: 42 });
const seeked = await json(await fetch(`${BASE}/api/rooms/${ROOM}/now`));
check("seek 生效", () => assert.ok(Math.abs(seeked.body.playback.position - 42) < 6));

await cmd({ type: "settings", hideTitle: true });
const hiddenNow = await json(await fetch(`${BASE}/api/rooms/${ROOM}/now`));
check("隐藏曲名生效", () => assert.equal(hiddenNow.body.track.title, null));
await cmd({ type: "settings", hideTitle: false });

console.log("\n[5b] 改设置不能打乱播放进度");
const midNow = (await json(await fetch(`${BASE}/api/rooms/${ROOM}/now`))).body;
// 挑一个"曲目中间"的位置：短测试曲也能用，别越过结尾（越过结尾会被正确判为播完）
const midPos = Math.max(0.3, Number(midNow.track.duration || 2) * 0.4);
await cmd({ type: "seek", position: midPos });
await sleep(300);
const beforeSettings = (await json(await fetch(`${BASE}/api/rooms/${ROOM}/now`))).body.playback.position;
await cmd({ type: "settings", volume: 0.5 });
const afterSettings = (await json(await fetch(`${BASE}/api/rooms/${ROOM}/now`))).body.playback.position;
check("调音量后播放位置不跳（不回到 0）", () => {
  assert.ok(afterSettings >= beforeSettings - 0.5, `改前 ${beforeSettings.toFixed(1)}s → 改后 ${afterSettings.toFixed(1)}s`);
  assert.ok(afterSettings > midPos * 0.5, `改后应仍在 ${midPos.toFixed(1)}s 附近，实际 ${afterSettings.toFixed(1)}s`);
});

await cmd({ type: "playlist", op: "move", from: 0, to: 0 });
const afterMove = (await json(await fetch(`${BASE}/api/rooms/${ROOM}/now`))).body.playback.position;
check("调整歌单顺序后位置也不跳", () => assert.ok(afterMove > midPos * 0.5, `实际 ${afterMove.toFixed(1)}s`));

const volNow = (await json(await fetch(`${BASE}/api/rooms/${ROOM}/now`))).body.playback.volume;
check("音量真的写进去了", () => assert.equal(volNow, 0.5));
console.log("\n[5c] 分类目录");
const folders0 = (await json(await fetch(`${BASE}/api/rooms/${ROOM}/state`, { headers: { Authorization: `Bearer ${gmToken}` } }))).body.folders;
check("新房间自带「探索/战斗」两个分类", () => assert.deepEqual(folders0, ["探索", "战斗"]), JSON.stringify(folders0));

await cmd({ type: "folder", op: "create", name: "城镇" });
const f1 = (await json(await fetch(`${BASE}/api/rooms/${ROOM}/state`, { headers: { Authorization: `Bearer ${gmToken}` } }))).body.folders;
check("可以自建分类", () => assert.ok(f1.includes("城镇")), JSON.stringify(f1));

const someTrack = (await json(await fetch(`${BASE}/api/rooms/${ROOM}/state`, { headers: { Authorization: `Bearer ${gmToken}` } }))).body.playlist[0];
await cmd({ type: "track.folder", trackId: someTrack.id, folder: "战斗" });
const moved = (await json(await fetch(`${BASE}/api/rooms/${ROOM}/state`, { headers: { Authorization: `Bearer ${gmToken}` } }))).body.playlist.find((t) => t.id === someTrack.id);
check("曲目可以归类", () => assert.equal(moved.folder, "战斗"));

const posBefore = (await json(await fetch(`${BASE}/api/rooms/${ROOM}/now`))).body.playback.position;
await cmd({ type: "folder", op: "rename", name: "战斗", newName: "Boss战" });
const afterRename = (await json(await fetch(`${BASE}/api/rooms/${ROOM}/state`, { headers: { Authorization: `Bearer ${gmToken}` } }))).body;
const posAfter = (await json(await fetch(`${BASE}/api/rooms/${ROOM}/now`))).body.playback.position;
check("分类改名会带着曲目一起走", () => {
  assert.ok(afterRename.folders.includes("Boss战"));
  assert.equal(afterRename.playlist.find((t) => t.id === someTrack.id).folder, "Boss战");
});
check("分类操作不会打乱播放进度", () => assert.ok(posAfter >= posBefore - 0.5, `${posBefore} → ${posAfter}`));

await cmd({ type: "folder", op: "remove", name: "Boss战" });
const afterDel = (await json(await fetch(`${BASE}/api/rooms/${ROOM}/state`, { headers: { Authorization: `Bearer ${gmToken}` } }))).body;
check("删分类后曲目回到未分类", () => {
  assert.ok(!afterDel.folders.includes("Boss战"));
  assert.equal(afterDel.playlist.find((t) => t.id === someTrack.id).folder, "");
});
console.log("\n[5d] 循环模式");
const loopOf = async () => (await json(await fetch(`${BASE}/api/rooms/${ROOM}/now`))).body.playback.loop;
await cmd({ type: "settings", loop: "track" });
const l1 = await loopOf();
check("能切到单曲循环", () => assert.equal(l1, "track"));
await cmd({ type: "settings", loop: "off" });
const l2 = await loopOf();
check("能切到不循环", () => assert.equal(l2, "off"));
await cmd({ type: "settings", loop: "list" });
const l3 = await loopOf();
check("能切回列表循环", () => assert.equal(l3, "list"));

console.log("\n[5e] 拖到结尾也不能让循环失效");
const beforeTail = (await json(await fetch(`${BASE}/api/rooms/${ROOM}/now`))).body;
const tailId = beforeTail.track.id;
const tailDur = beforeTail.track.duration;
await cmd({ type: "settings", loop: "track" });
await cmd({ type: "seek", position: tailDur - 0.05 });
await sleep(1500);
const afterTail = (await json(await fetch(`${BASE}/api/rooms/${ROOM}/now`))).body;
check("拖到结尾后单曲循环会重新开始", () => {
  assert.equal(afterTail.playback.trackId, tailId, "曲目应该不变");
  assert.ok(afterTail.playback.position < 2, `应该回到开头，实际 ${afterTail.playback.position}`);
  assert.equal(afterTail.playback.playing, true);
});
await cmd({ type: "settings", loop: "list" });
await cmd({ type: "settings", loop: "list" });
console.log("\n[6] SSE 分流");
const gmFrames = [];
const ac = new AbortController();
const sse = await fetch(`${BASE}/api/rooms/${ROOM}/events?token=${gmToken}`, { signal: ac.signal });
const pump = (async () => {
  const reader = sse.body.getReader();
  const dec = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      gmFrames.push(dec.decode(value, { stream: true }));
    }
  } catch {}
})();
await sleep(300);
await cmd({ type: "pause" });
await sleep(400);
ac.abort();
await pump;
check("GM 收到 state + now", () => {
  const all = gmFrames.join("");
  assert.match(all, /event: state/);
  assert.match(all, /event: now/);
});

const playerFrames = [];
const ac2 = new AbortController();
const sse2 = await fetch(`${BASE}/api/rooms/${ROOM}/events`, { signal: ac2.signal });
const pump2 = (async () => {
  const reader = sse2.body.getReader();
  const dec = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      playerFrames.push(dec.decode(value, { stream: true }));
    }
  } catch {}
})();
await sleep(300);
ac2.abort();
await pump2;
check("玩家 SSE 没有 state / 歌单", () => {
  const all = playerFrames.join("");
  assert.doesNotMatch(all, /event: state/);
  assert.doesNotMatch(all, /playlist/);
});

console.log("\n[7] B 站");
const bili = await json(
  await fetch(`${BASE}/api/rooms/${ROOM}/tracks/bilibili`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${gmToken}` },
    body: JSON.stringify({ url: "https://www.bilibili.com/video/BV1k7xy6fEtL" }),
  })
);
check("B 站链接解析成功", () => {
  assert.equal(bili.status, 200, JSON.stringify(bili.body));
  assert.ok(bili.body.track.duration > 0);
  assert.ok(bili.body.track.title.length > 0);
});

const biliAudio = await fetch(`${BASE}/audio/${ROOM}/${bili.body.track.id}`, { headers: { Range: "bytes=0-2047" } });
const biliBuf = Buffer.from(await biliAudio.arrayBuffer());
check("B 站音轨代理可取到字节", () => {
  assert.ok([200, 206].includes(biliAudio.status));
  assert.ok(biliBuf.length > 1000);
});

console.log("\n[8] 自动切歌");
const R2 = "autoadv";
const gm2 = await json(
  await fetch(`${BASE}/api/rooms/${R2}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: "gm-3", name: "GM3" }),
  })
);
const upload = async (name) =>
  (
    await json(
      await fetch(`${BASE}/api/rooms/${R2}/tracks?name=${encodeURIComponent(name)}&duration=2`, {
        method: "POST",
        headers: { Authorization: `Bearer ${gm2.body.token}` },
        body: wav(2),
      })
    )
  ).body.track;

const t1 = await upload("一.wav");
const t2 = await upload("二.wav");
await fetch(`${BASE}/api/rooms/${R2}/command`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${gm2.body.token}` },
  body: JSON.stringify({ type: "select", trackId: t1.id }),
});
await sleep(3000);
const advanced = await json(await fetch(`${BASE}/api/rooms/${R2}/now`));
check("2 秒曲目播完自动切下一首", () => assert.equal(advanced.body.playback.trackId, t2.id));

// ---------- 启动脚本的故障路径（曾把真错误盖成 ReferenceError） ----------
{
  const { spawnSync } = await import("node:child_process");
  const root = path.resolve(import.meta.dirname, "..");
  // 用一个必然被占用的端口：先自己监听，再跑启动脚本
  const net = await import("node:net");
  const blocker = net.createServer(() => {});
  await new Promise((r) => blocker.listen(0, "0.0.0.0", r));
  const busy = blocker.address().port;
  const r = spawnSync(process.execPath, [path.join(root, "scripts/setup.mjs"), "--port", String(busy), "--no-tunnel"], {
    cwd: root,
    encoding: "utf8",
    timeout: 40000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  const out = (r.stdout || "") + (r.stderr || "");
  check("端口被占用时给出可读提示，而不是抛 ReferenceError", () => {
    assert.ok(/已被占用/.test(out), `输出应包含“已被占用”，实际：${out.slice(0, 300)}`);
    assert.ok(!/ReferenceError/.test(out), "不应出现 ReferenceError");
  });
  check("端口被占用时不显示安装地址（不会把旧实例当成自己）", () => {
    assert.ok(!/扩展安装地址/.test(out), "不应显示安装地址");
  });
  check("端口被占用时以非零码退出", () => assert.notEqual(r.status, 0));
  await new Promise((r2) => blocker.close(r2));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
fs.rmSync(DATA, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
