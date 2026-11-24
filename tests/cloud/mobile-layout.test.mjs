import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mobilePopoverTarget, fitMobilePopover, jumpScroll, createMomentumScroller, installIosTouchScroll } from "../../public/cloud/mobile-popover.js";

test("移动端 iframe 采用固定视口滚动和充足滚动余量，保留手动翻页按钮", async () => {
  const css = await readFile(new URL("../../public/style.css", import.meta.url), "utf8");
  const mobile = css.match(/@media\s*\(pointer:\s*coarse\)\s*and\s*\(max-width:\s*560px\)\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(mobile, "应保留触屏手机专用的容器高度规则");
  assert.match(mobile, /\.app\s*\{[^}]*position:\s*fixed;[^}]*height:\s*100%;[^}]*max-height:\s*100%/);
  assert.match(mobile, /\.main\s*\{[^}]*overflow-y:\s*scroll;[^}]*-webkit-overflow-scrolling:\s*touch;[^}]*touch-action:\s*pan-y;[^}]*padding-bottom:\s*calc\(220px/);
  assert.match(mobile, /\.mobile-scroll-jump\s*\{\s*display:\s*inline-flex/);
  assert.doesNotMatch(mobile, /320px|150px/);
  assert.match(css, /html,\s*body\s*\{[^}]*height:\s*100%/);
  assert.match(css, /\.main\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.main\s*\{[^}]*padding:[^}]*safe-area-inset-bottom/);
  const page = await readFile(new URL("../../public/index.html",import.meta.url),"utf8");
  assert.match(page,/data-act="mobile-scroll"/);
  assert.match(page,/style\.css\?v=3\.3\.10/);
  assert.match(page,/app\.js\?v=3\.3\.10/);
});

test("只在窄屏 iPhone 使用官方 Owlbear Action API 缩小高于可视区域的浮窗", async () => {
  const env = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X)",
    coarse: true, width: 393, screenHeight: 852 };
  assert.equal(mobilePopoverTarget(env), 494);
  assert.equal(mobilePopoverTarget({ ...env, screenHeight: 390 }), 280);
  assert.equal(mobilePopoverTarget({ ...env, width: 800 }), null);
  assert.equal(mobilePopoverTarget({ ...env, userAgent: "Mozilla/5.0 (Windows NT 10.0)" }), null);
  assert.equal(mobilePopoverTarget({ ...env, coarse: false }), null);
  let calls = 0;
  const sdk = { action: { getHeight: async () => 640,
    setHeight: async (height) => { calls++; assert.equal(height, 494); } } };
  assert.deepEqual(await fitMobilePopover(sdk, env), { target: 494, current: 640, changed: true });
  assert.equal(calls, 1);
  sdk.action.getHeight = async () => 480;
  assert.deepEqual(await fitMobilePopover(sdk, env), { target: 494, current: 480, changed: false });
  assert.equal(calls, 1);
  assert.equal(await fitMobilePopover({}, env), null);
});

test("滚动按钮无需 Safari 触摸事件即可依次向下翻页、到底后返回顶部", () => {
  const main = { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 };
  assert.deepEqual(jumpScroll(main), { changed: true, atBottom: false, max: 600 });
  assert.equal(main.scrollTop, 260);
  jumpScroll(main);
  assert.equal(main.scrollTop, 520);
  assert.deepEqual(jumpScroll(main), { changed: true, atBottom: true, max: 600 });
  assert.equal(main.scrollTop, 600);
  assert.deepEqual(jumpScroll(main), { changed: true, atBottom: false, max: 600 });
  assert.equal(main.scrollTop, 0);
  assert.deepEqual(jumpScroll({scrollHeight:200,clientHeight:200,scrollTop:0}),
    {changed:false,atBottom:true,max:0});
});

test("后备惯性松手后继续衰减滑动，可被新触摸立即取消，并会在边界停止", () => {
  const frames = new Map();
  let nextId = 0;
  const timing = {
    requestFrame: (callback) => { frames.set(++nextId, callback); return nextId; },
    cancelFrame: (id) => frames.delete(id),
  };
  const runFrame = (time) => {
    const [id, callback] = frames.entries().next().value ?? [];
    if (!callback) return false;
    frames.delete(id);
    callback(time);
    return true;
  };
  const main = { scrollHeight: 1200, clientHeight: 400, scrollTop: 100 };
  const driver = createMomentumScroller(main, timing);
  assert.equal(driver.start(1.1), true);
  assert.equal(driver.running, true);
  runFrame(16.7);
  const first = main.scrollTop - 100;
  runFrame(33.4);
  const second = main.scrollTop - 100 - first;
  assert.ok(first > 10 && second > 0 && second < first, "逐帧位移应衰减而非匀速");
  const stoppedAt = main.scrollTop;
  driver.stop();
  assert.equal(driver.running, false);
  assert.equal(frames.size, 0, "再次按下时须立即取消动画");
  assert.equal(runFrame(50), false);
  assert.equal(main.scrollTop, stoppedAt);

  main.scrollTop = 795;
  assert.equal(driver.start(2.4), true);
  runFrame(66.7);
  assert.equal(main.scrollTop, 800);
  assert.equal(driver.running, false, "滑到最大滚动边界立即结束");
  assert.equal(driver.start(Number.NaN), false);
  assert.equal(driver.start(0.02), false);
});

test("iPhone 原生滚动未开始时接管上滑，已原生滚动或拖动交互控件时不劫持手势", () => {
  const listeners = new Map();
  const main = { scrollHeight: 950, clientHeight: 450, scrollTop: 0,
    addEventListener: (type, callback) => listeners.set(type, callback),
    removeEventListener: (type) => listeners.delete(type) };
  const rafs = new Map();
  let frameId = 0;
  let time = 0;
  const stop = installIosTouchScroll(main, "Mozilla/5.0 (iPhone; CPU iPhone OS 26_6)", {
    now: () => time,
    requestFrame: cb => { rafs.set(++frameId, cb); return frameId; },
    cancelFrame: id => rafs.delete(id),
  });
  let prevented = 0;
  const start = (y, interactive = false) =>
    listeners.get("touchstart")({ touches: [{ clientY: y }],
      target: { closest: () => interactive ? {} : null } });
  const move = (y) => listeners.get("touchmove")({
    touches: [{ clientY: y }], cancelable: true, preventDefault: () => prevented++,
  });
  start(390);
  move(385);
  assert.equal(main.scrollTop, 0, "轻微移动不应触发滚动");
  time = 20;
  move(300);
  assert.equal(main.scrollTop, 90);
  assert.equal(prevented, 1);
  time = 36;
  move(250);
  assert.equal(main.scrollTop, 140);
  time = 42;
  listeners.get("touchend")();
  assert.equal(rafs.size, 1, "手动滚动松手后应安排惯性帧");
  const [frame, callback] = rafs.entries().next().value;
  rafs.delete(frame);
  callback(56);
  assert.ok(main.scrollTop > 140, "松手后应继续移动而非瞬停");
  const inertialTop = main.scrollTop;
  start(390, true);
  assert.equal(rafs.size, 0, "新触摸立即刹停惯性");
  move(240);
  assert.equal(main.scrollTop, inertialTop, "从按钮/进度条开始的手势不应被劫持");
  start(390);
  main.scrollTop = inertialTop + 25; // Safari 先启动原生滚动
  move(240);
  assert.equal(main.scrollTop, inertialTop + 25, "已原生滚动时不得造成双重位移");
  listeners.get("touchend")();
  assert.equal(rafs.size, 0, "Safari 原生惯性不应再被脚本叠加");
  stop();
  assert.equal(listeners.size, 0);
});
