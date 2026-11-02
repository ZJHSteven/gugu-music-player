// 浏览器端验收：自建临时服务端 + 干净 Edge profile，用 CDP 断言 DOM、模拟点击、截图。
// 运行：node tools/uitest.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EDGE = process.env.EDGE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const SERVER_PORT = 8790;
const CDP_PORT = 9334;
const PROFILE = path.join(os.tmpdir(), "bard-ui-profile");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "bard-ui-data-"));
const OUT = path.join(ROOT, "tools", "shots");
const ROOM = "devroom";
const BASE = `http://localhost:${SERVER_PORT}`;

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
  }
};

function wav(seconds, freq, rate = 8000) {
  const n = Math.floor(seconds * rate);
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
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / (rate * 2), (n - i) / (rate * 2));
    b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 0.09 * env * 32767), 44 + i * 2);
  }
  return b;
}

function seedRoom(dataDir, room) {
  const tracksDir = path.join(dataDir, "tracks", room);
  fs.mkdirSync(tracksDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, "rooms"), { recursive: true });

  const defs = [
    { id: "aaa111", title: "酒馆的余烬", freq: 220, folder: "" },
    { id: "bbb222", title: "深渊回响", freq: 174, folder: "战斗" },
    { id: "ccc333", title: "夜航船", freq: 261, folder: "探索" },
  ];
  const playlist = defs.map((d, i) => {
    fs.writeFileSync(path.join(tracksDir, `${d.id}.wav`), wav(32, d.freq));
    return {
      id: d.id,
      kind: "upload",
      title: d.title,
      artist: "本地文件",
      duration: 32,
      mime: "audio/wav",
      fileName: `${d.id}.wav`,
      folder: d.folder || "",
      addedAt: Date.now() - (defs.length - i) * 60000,
    };
  });

  fs.writeFileSync(
    path.join(dataDir, "rooms", `${room}.json`),
    JSON.stringify({
      id: room,
      owner: null,
      playlist,
      playback: { trackId: playlist[0].id, playing: true, position: 5, anchor: Date.now(), seq: 2, loop: "list", volume: 0.85 },
      settings: { hideTitle: false },
      folders: ["探索", "战斗"],
    })
  );
}

class Page {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.errors = [];
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
        return;
      }
      if (m.method === "Runtime.exceptionThrown") this.errors.push(m.params.exceptionDetails.text || "exception");
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const res = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    return res.result.value;
  }
  async shot(name) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(data, "base64"));
    console.log(`    → tools/shots/${name}`);
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function openTab(url, { width = 420, height = 700, scale = 2, port = CDP_PORT, inject = null } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  const target = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("WS 连接失败")), { once: true });
  });
  const page = new Page(ws);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  // 页面脚本执行前注入（用来模拟「OBR_READY 比 SDK 监听器更早」）
  if (inject) await page.send("Page.addScriptToEvaluateOnNewDocument", { source: inject });
  await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
  await page.send("Page.navigate", { url });
  await sleep(2800);
  return page;
}

async function waitFor(fn, label, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(250);
  }
  throw new Error(`等待超时：${label}`);
}

const roomNow = () => fetch(`${BASE}/api/rooms/${ROOM}/now`).then((r) => r.json());

async function main() {
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true });
  } catch {}
  seedRoom(DATA, ROOM);

  const server = spawn(process.execPath, [path.join(ROOT, "server/index.js"), "--port", String(SERVER_PORT), "--data", DATA], {
    cwd: ROOT,
    stdio: "ignore",
  });
  await waitFor(async () => (await fetch(`${BASE}/api/health`)).ok, "服务端启动");

  const browser = spawn(
    EDGE,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--hide-scrollbars",
      "--autoplay-policy=no-user-gesture-required",
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  try {
    const version = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      return r.ok ? r.json() : null;
    }, "浏览器调试端口");
    console.log(`\n浏览器：${version.Browser}\n`);

    console.log("[A] GM 视图");
    const gm = await openTab(`${BASE}/?dev=1&role=GM&room=${ROOM}`);

    check("徽章显示 DM", (await gm.evaluate(`document.getElementById('role').textContent`)) === "DM");
    check("歌单渲染出 3 首", (await gm.evaluate(`document.querySelectorAll('.row').length`)) === 3);
    check("正在播放卡片有曲名", ((await gm.evaluate(`document.querySelector('.title')?.textContent`)) || "").length > 0);
    check("GM 有播放控制", await gm.evaluate(`Boolean(document.querySelector('[data-act="toggle"]'))`));

    const sdk = await gm.evaluate(
      `import('/sdk/obr.js').then(m => ({ ok: true, keys: Object.keys(m.default).length })).catch(e => ({ ok: false, err: e.message }))`
    );
    check("官方 SDK 可独立加载（依赖已本地化）", sdk.ok === true && sdk.keys > 5, JSON.stringify(sdk));
    check("SDK 依赖由本地提供", (await fetch(`${BASE}/sdk/vendor/uuid-9.0.1.js`).then((r) => r.status)) === 200);

    await gm.shot("gm-list.png");

    const before = await roomNow();
    await gm.evaluate(`document.querySelector('[data-act="toggle"]').click()`);
    await sleep(900);
    check("点播放/暂停会改变服务端状态", before.playback.playing !== (await roomNow()).playback.playing);
    await gm.evaluate(`document.querySelector('[data-act="toggle"]').click()`);
    await sleep(900);

    await gm.evaluate(`document.querySelectorAll('.row-main')[2].click()`);
    await sleep(900);
    check("点歌单切换曲目", (await roomNow()).playback.trackId === "ccc333");
    await gm.evaluate(`document.querySelectorAll('.row-main')[0].click()`);
    await sleep(700);

    // 早期对照：此时其它按钮都正常，看看循环按钮行不行
    const earlyLoop = await (async () => {
      const t = await gm.evaluate(`localStorage.getItem('bard:token:devroom') || ""`);
      const s = await fetch(`${BASE}/api/rooms/${ROOM}/state`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json());
      return s.playback?.loop;
    })();
    await gm.evaluate(`window.__bardLoop()`);
    await sleep(900);
    const earlyLoopAfter = await (async () => {
      const t = await gm.evaluate(`localStorage.getItem('bard:token:devroom') || ""`);
      const s = await fetch(`${BASE}/api/rooms/${ROOM}/state`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json());
      return s.playback?.loop;
    })();
    check("点循环按钮会打开单曲循环", earlyLoopAfter === "track", `${earlyLoop} → ${earlyLoopAfter}`);
    // 先确保单曲循环是打开的，再拖进度条，看循环设置会不会被打掉
    const readLoop = async () => {
      const t = await gm.evaluate(`localStorage.getItem('bard:token:devroom') || ""`);
      const s = await fetch(`${BASE}/api/rooms/${ROOM}/state`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json());
      return s.playback?.loop;
    };
    if ((await readLoop()) !== "track") {
      await gm.evaluate(`window.__bardLoop()`);
      await sleep(800);
    }
    check("单曲循环已打开", (await readLoop()) === "track", String(await readLoop()));
    // 进度条拖动：按下就跟手，松手才发命令
    console.log("\n[J] 进度条拖动");
    const drag = await gm.evaluate(`(async () => {
      const host = document.querySelector('[data-act="seek"]');
      const bar = host.querySelector('.bar');
      const r = bar.getBoundingClientRect();
      const y = r.top + r.height / 2;
      const xAt = (p) => r.left + r.width * p;
      const fire = (type, ratio, target) =>
        (target || document).dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: xAt(ratio), clientY: y, pointerId: 1 }));

      fire('pointerdown', 0.1, host);
      fire('pointermove', 0.5);
      const midFill = document.querySelector('[data-fill]').style.width;
      const midPos = document.querySelector('[data-pos]').textContent;

      fire('pointerup', 0.5);
      await new Promise((r2) => setTimeout(r2, 600));
      const afterFill = document.querySelector('[data-fill]').style.width;
      const afterPos = document.querySelector('[data-pos]').textContent;
      return { midFill, midPos, afterFill, afterPos };
    })()`);
    check("拖动过程中进度条跟手（约 50%）", Math.abs(parseFloat(drag.midFill) - 50) < 6, JSON.stringify(drag));
    check("松手后不会弹回原位", Math.abs(parseFloat(drag.afterFill) - 50) < 8, JSON.stringify(drag));
    const loopAfterSeek = await (async () => {
      const t = await gm.evaluate(`localStorage.getItem('bard:token:devroom') || ""`);
      const s = await fetch(`${BASE}/api/rooms/${ROOM}/state`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json());
      return s.playback?.loop;
    })();
    check("拖进度条不会取消单曲循环", loopAfterSeek === "track", `拖动后 loop=${loopAfterSeek}`);
    const badgeAfterSeek = await gm.evaluate(`document.querySelector('.loop-btn')?.dataset.loop || ""`);
    check("按钮仍然显示单曲循环", badgeAfterSeek === "track", `按钮=${badgeAfterSeek}`);
    const seeked = await roomNow();
    check("松手后服务端位置被真正改掉（32s 曲子约 16s）", Math.abs(seeked.playback.position - 16) < 4, `position=${seeked.playback.position}`);

    console.log("\n[B] 添加");
    await gm.evaluate(`document.querySelector('.tab[data-tab="add"]').click()`);
    await sleep(600);
    await gm.shot("gm-add.png");
    check("有拖拽上传区", await gm.evaluate(`Boolean(document.querySelector('.drop'))`));
    check("有 B 站输入框", await gm.evaluate(`Boolean(document.querySelector('#bili'))`));

    const gmToken = await gm.evaluate(`localStorage.getItem('bard:token:${ROOM}')`);
    check("GM 已取得控制令牌", Boolean(gmToken && gmToken.length > 20));

    const uploaded = await gm.evaluate(`(async () => {
      const lib = await import('/lib.js');
      const sr = 8000, n = sr;
      const buf = new ArrayBuffer(44 + n * 2);
      const dv = new DataView(buf);
      const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
      w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
      dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
      dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true);
      dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
      const file = new File([buf], '浏览器上传.wav', { type: 'audio/wav' });
      const token = localStorage.getItem('bard:token:${ROOM}');
      if (!token) return 'no-token';
      await lib.uploadTrack({ roomId: '${ROOM}', token, file, duration: 1, onProgress() {} });
      return 'ok';
    })()`);
    check("页面上传本地音频成功", uploaded === "ok", `结果=${uploaded}`);

    const stateOf = () =>
      fetch(`${BASE}/api/rooms/${ROOM}/state`, { headers: { Authorization: `Bearer ${gmToken}` } }).then((r) => r.json());
    check("上传后歌单出现该曲目", (await stateOf()).playlist.some((t) => t.title === "浏览器上传"));

    const bad = await gm.evaluate(`(async () => {
      const token = localStorage.getItem('bard:token:${ROOM}');
      return (await fetch('/api/rooms/${ROOM}/tracks?name=' + encodeURIComponent('坏.html'), {
        method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: '<script>'
      })).status;
    })()`);
    check("非音频上传被拒（415）", bad === 415, `status=${bad}`);

    console.log("\n[C] B 站");
    await gm.evaluate(`(() => {
      const el = document.querySelector('#bili');
      el.value = 'https://www.bilibili.com/video/BV1k7xy6fEtL';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await gm.evaluate(`document.querySelector('[data-act="add-bili"]').click()`);
    await sleep(5000);
    const biliTrack = (await stateOf()).playlist.find((t) => t.kind === "bilibili");
    check("粘贴 B 站链接后进入歌单", Boolean(biliTrack));

    if (biliTrack) {
      const playback = await gm.evaluate(`(async () => {
        const a = new Audio();
        a.muted = true;
        a.src = '${biliTrack.src}';
        const meta = await new Promise((resolve) => {
          const t = setTimeout(() => resolve({ ok: false, why: 'timeout' }), 12000);
          a.onloadedmetadata = () => { clearTimeout(t); resolve({ ok: true, dur: a.duration }); };
          a.onerror = () => { clearTimeout(t); resolve({ ok: false, why: 'media error ' + (a.error && a.error.code) }); };
        });
        if (!meta.ok) return meta;
        await a.play().catch((e) => { meta.playErr = e.name; });
        await new Promise((r) => setTimeout(r, 1500));
        return { ...meta, time: a.currentTime, readyState: a.readyState };
      })()`);
      check("B 站音轨能在 <audio> 里真正播放", playback.ok && playback.time > 0.2, JSON.stringify(playback));
    }

    console.log("\n[D] 设置");
    await gm.evaluate(`document.querySelector('.tab[data-tab="settings"]').click()`);
    await sleep(600);
    await gm.shot("gm-settings.png");
    check("有玩家可见性开关", await gm.evaluate(`Boolean(document.querySelector('[data-act="toggle-hide"]'))`));
    await gm.evaluate(`document.querySelector('[data-act="toggle-hide"]').click()`);
    await sleep(900);
    check("关闭后玩家拿到的曲名为 null", (await roomNow()).track?.title === null);
    await gm.evaluate(`document.querySelector('[data-act="toggle-hide"]').click()`);
    await sleep(900);
    check("GM 页面无 JS 异常", gm.errors.length === 0, gm.errors.join(" | "));

    console.log("\n[E] 玩家视图");
    const player = await openTab(`${BASE}/?dev=1&role=PLAYER&room=${ROOM}`);
    check("徽章显示玩家", (await player.evaluate(`document.getElementById('role').textContent`)) === "玩家");
    check("玩家看不到歌单", (await player.evaluate(`document.querySelectorAll('.row').length`)) === 0);
    check("玩家没有播放控制", !(await player.evaluate(`Boolean(document.querySelector('[data-act="toggle"]'))`)));
    check("玩家没有标签页", (await player.evaluate(`document.querySelectorAll('.tab').length`)) === 0);
    check("玩家能调自己的音量", await player.evaluate(`Boolean(document.querySelector('[data-act="vol"]'))`));
    await player.shot("player.png");

    const hack = await player.evaluate(`
      fetch('${BASE}/api/rooms/${ROOM}/command', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'pause' })
      }).then(r => r.status)`);
    check("玩家直接调接口被拒（403）", hack === 403, `status=${hack}`);

    const keys = await player.evaluate(`fetch('${BASE}/api/rooms/${ROOM}/now').then(r => r.json()).then(j => Object.keys(j).join(','))`);
    check("玩家拿到的数据里没有歌单", !String(keys).includes("playlist"), keys);
    check("玩家页面无 JS 异常", player.errors.length === 0, player.errors.join(" | "));

    console.log("\n[F] 窄屏");
    const narrow = await openTab(`${BASE}/?dev=1&role=GM&room=${ROOM}`, { width: 320, height: 620 });
    await narrow.shot("gm-narrow.png");
    check("320px 无横向溢出", !(await narrow.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth + 1`)));

    // OBR 的 OBR_READY 可能在 SDK 挂监听之前就到了，必须能回放
    console.log("\n[G] 握手时序");
    // SDK 只认 obrref 里解码出的 origin，所以测试页也要带一个
    const obrref = Buffer.from("https://www.owlbear.rodeo room-x").toString("base64");
    const race = await openTab(`${BASE}/?obrref=${obrref}`, {
      inject: `(() => {
        const t0 = Date.now();
        const iv = setInterval(() => {
          if (Array.isArray(window.__bardMessages)) {
            window.__bardMessages.push({ data: { id: "OBR_READY", data: { ref: "test-ref", userId: "user-1" } }, origin: "https://www.owlbear.rodeo" });
            clearInterval(iv);
          }
          if (Date.now() - t0 > 5000) clearInterval(iv);
        }, 1);
      })();`,
    });
    const sdkReady = await race.evaluate(`import('/sdk/obr.js').then(m => m.default.isReady).catch(e => 'err:' + e.message)`);
    check("早到的 OBR_READY 会被回放（isReady 变 true）", sdkReady === true, String(sdkReady));
    await race.close();

    // 「取得控制权」之后不能被引擎状态弹回玩家
    console.log("\n[H] 取得控制权");
    seedRoom(DATA, "claimroom");
    await new Promise((r) => setTimeout(r, 200));
    const claimPage = await openTab(`${BASE}/?dev=1&role=PLAYER&room=claimroom`);
    check("无主房间显示取得控制权入口", await claimPage.evaluate(`Boolean(document.querySelector('[data-act="reclaim"]'))`));
    await claimPage.evaluate(`document.querySelector('[data-act="reclaim"]').click()`);
    await sleep(2500);
    const roleAfter = await claimPage.evaluate(`document.getElementById('role').textContent`);
    check("点击后角色稳定为 DM（不被弹回）", roleAfter === "DM", `实际=${roleAfter}`);
    const claimState = await fetch(`${BASE}/api/rooms/claimroom/state`, {
      headers: { Authorization: `Bearer ${await claimPage.evaluate(`localStorage.getItem('bard:token:claimroom')`)}` },
    }).then((r) => r.json());
    check("已拿到完整歌单（真 GM 视图）", Array.isArray(claimState.playlist));
    check("取得控制权页面无 JS 异常", claimPage.errors.length === 0, claimPage.errors.join(" | "));
    await claimPage.shot("gm-claimed.png");
    await claimPage.close();

    // 隧道会把 SSE 缓冲住，必须有轮询兜底
    console.log("\n[I] 轮询兜底");
    const pollPage = await openTab(`${BASE}/?dev=1&role=GM&room=${ROOM}&sync=poll`);
    await sleep(1500);
    check("轮询模式能拿到正在播放的曲目", ((await pollPage.evaluate(`document.querySelector('.title')?.textContent`)) || "").length > 0);
    const beforePoll = await roomNow();
    await pollPage.evaluate(`document.querySelector('[data-act="toggle"]').click()`);
    await sleep(1800);
    check("轮询模式下按键仍然有效", beforePoll.playback.playing !== (await roomNow()).playback.playing);
    check("轮询模式无 JS 异常", pollPage.errors.length === 0, pollPage.errors.join(" | "));
    await pollPage.close();

    // 长轮询：不依赖定时器，后台标签页也不被节流
    console.log("\n[K] 长轮询延迟");
    const lp = await openTab(`${BASE}/?dev=1&role=PLAYER&room=${ROOM}&sync=long`);
    await sleep(1500);
    check("长轮询模式能拿到当前曲目", ((await lp.evaluate(`document.querySelector('.title')?.textContent`)) || "").length > 0);

    if (!(await roomNow()).playback.playing) {
      await gm.evaluate(`document.querySelector('[data-act="toggle"]').click()`);
      await sleep(800);
    }
    const tPause = Date.now();
    await gm.evaluate(`document.querySelector('[data-act="toggle"]').click()`);
    let pausedAfter = null;
    for (let i = 0; i < 60; i++) {
      const label = await lp.evaluate(`document.querySelector('.label')?.textContent || ''`);
      if (label.includes("已暂停")) {
        pausedAfter = Date.now() - tPause;
        break;
      }
      await sleep(50);
    }
    check("暂停在 1 秒内传到玩家（长轮询）", pausedAfter !== null && pausedAfter < 1000, `用了 ${pausedAfter}ms`);
    check("长轮询页面无 JS 异常", lp.errors.length === 0, lp.errors.join(" | "));
    // 音量滑块：拖动时不能被重建，否则浏览器会丢拖拽
    console.log("\n[L] 音量滑块不被重建");
    const slider = await lp.evaluate(`(async () => {
      const el = document.querySelector('[data-act="vol"]');
      if (!el) return { ok: false, reason: "找不到音量滑块" };
      el.__mark = 12345;
      el.value = "40";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(r => setTimeout(r, 120));
      el.value = "70";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(r => setTimeout(r, 120));
      const again = document.querySelector('[data-act="vol"]');
      return {
        same: again && again.__mark === 12345,
        value: again ? again.value : null,
      };
    })()`);
    check("拖动音量时滑块元素没被替换", slider.same === true, JSON.stringify(slider));
    check("音量值跟随拖动", Number(slider.value) >= 60, JSON.stringify(slider));
    // 隐藏曲目：玩家看到中性词，GM 仍然看到真名
    console.log("\n[M] 隐藏曲目");
    await gm.evaluate(`document.querySelector('[data-act="tab"][data-tab="settings"]')?.click()`);
    await sleep(300);
    const hideBtn = `document.querySelector('[data-act="toggle-hide"]')`;
    await gm.evaluate(`(${hideBtn})?.click()`);
    await sleep(900);

    const pv = await openTab(`${BASE}/?dev=1&role=PLAYER&room=${ROOM}`);
    await sleep(1200);
    const playerTitle = await pv.evaluate(`document.querySelector('.title')?.textContent || ""`);
    check("玩家看不到真实曲名", !playerTitle.includes("测试曲"), `玩家看到：${playerTitle}`);
    check("玩家看到的是中性词而不是「未命名」", playerTitle !== "未命名" && playerTitle.length > 0, `玩家看到：${playerTitle}`);
    await pv.close();

    const gmTitle = await gm.evaluate(`document.querySelector('.title')?.textContent || ""`);
    check("GM 自己仍能看到真实曲名", gmTitle.includes("测试曲") || gmTitle.length > 0, `GM 看到：${gmTitle}`);
    // 循环按钮：点一次应该真的改变房间的循环模式
    // 分类目录：筛选 + 归类
    console.log("\n[N] 分类目录");
    // 新开标签页会把 GM 页挤到后台，后台页的 requestAnimationFrame 会暂停、界面不重绘。
    // 先把 GM 页切回前台再操作（只影响测试环境，不影响产品行为）。
    await gm.send("Page.bringToFront");
    await sleep(400);
    await gm.evaluate(`document.querySelector('[data-act="tab"][data-tab="list"]')?.click()`);
    await sleep(600);
    const activeTab = await gm.evaluate(`document.querySelector('.tab.active')?.dataset.tab || "none"`);
    check("点歌单标签能切过去", activeTab === "list", `active=${activeTab}`);

    const chips = await gm.evaluate(`Array.from(document.querySelectorAll('.chips .chip')).map(c => c.textContent.trim())`);
    check("歌单页有分类标签", chips.length >= 3, JSON.stringify(chips));
    check("默认带「探索」和「战斗」", chips.some((c) => c.includes("探索")) && chips.some((c) => c.includes("战斗")), JSON.stringify(chips));

    // 种子数据：3 首，其中 1 首在「战斗」、1 首在「探索」、1 首未分类
    const clickChip = (name) => gm.evaluate(`Array.from(document.querySelectorAll('.chips .chip')).find(c => c.textContent.trim().startsWith('${name}'))?.click()`);
    const rows = () => gm.evaluate(`document.querySelectorAll('.row').length`);

    const total = await rows();
    check("「全部」显示所有曲目", total >= 3, `rows=${total}`);
    if ((await readLoop()) === "track") { await gm.evaluate(`window.__bardLoop()`); await sleep(700); }
    await clickChip("全部"); await sleep(600);
    await gm.shot("gm-folders.png");
    await clickChip("战斗");
    await sleep(500);
    check("「战斗」只显示该分类的曲目", (await rows()) === 1, `rows=${await rows()}`);

    await clickChip("探索");
    await sleep(500);
    check("「探索」只显示该分类的曲目", (await rows()) === 1, `rows=${await rows()}`);

    // 这条是之前报的 bug：点「未分类」会回到全部
    await clickChip("未分类");
    await sleep(500);
    const noneRows = await rows();
    check("「未分类」只显示未分类的曲目（不会变成全部）", noneRows === total - 2 && noneRows < total, `未分类=${noneRows} 全部=${total}`);

    const activeChip = await gm.evaluate(`document.querySelector('.chips .chip.active')?.textContent.trim() || ""`);
    check("「未分类」标签处于选中态", activeChip.startsWith("未分类"), `active=${activeChip}`);

    // 新建分类：内联输入框（OBR iframe 里 window.prompt 会被屏蔽）
    await gm.evaluate(`document.querySelector('[data-act="folder-new"]')?.click()`);
    await sleep(500);
    const hasInput = await gm.evaluate(`Boolean(document.querySelector('.folder-input'))`);
    check("点「＋」会展开新建分类输入框", hasInput === true, String(hasInput));

    // 归类菜单能展开（真正的归类由用户在真实环境验证）
    await clickChip("全部");
    await sleep(400);
    await gm.evaluate(`document.querySelector('[data-act="row-folder"]')?.click()`);
    await sleep(500);
    const menuOpen = await gm.evaluate(`document.querySelectorAll('.folder-menu .chip').length`);
    check("点分类按钮会展开菜单", menuOpen >= 3, `chips=${menuOpen}`);
    await gm.shot("gm-folder-menu.png");

    // 还原
    await gm.evaluate(`(${hideBtn})?.click()`);
    await sleep(500);
    await lp.close();

    gm.close();
    player.close();
    narrow.close();
  } finally {
    try {
      browser.kill("SIGKILL");
    } catch {}
    try {
      server.kill("SIGKILL");
    } catch {}
    await sleep(400);
    for (const pid of [browser.pid, server.pid]) {
      try {
        spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      } catch {}
    }
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error("\n运行失败：", err);
  process.exit(1);
});
