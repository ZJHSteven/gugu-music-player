/**
 * Owlbear 的手机 Action 可能保留 Manifest 声明的 640px iframe，
 * 而 iOS Safari 中宿主真正露出的部分比 640px 小。
 * 使用官方 OBR.action.setHeight 请求缩小 popover，子 iframe 无法
 * 跨域直接读取 Owlbear 的可见裁剪矩形。
 */
export function mobilePopoverTarget({
  userAgent = "", coarse = false, width = 0, screenHeight = 0,
} = {}) {
  if (!/iPhone|iPod/i.test(userAgent) || !coarse || width > 560 ||
      !Number.isFinite(screenHeight) || screenHeight < 300) return null;
  // Safari 浏览器工具条、Owlbear 顶部/底部工具条都占用屏幕。
  return Math.max(280, Math.min(500, Math.floor(screenHeight * 0.58)));
}

export async function fitMobilePopover(OBR, environment = {}) {
  const target = mobilePopoverTarget(environment);
  if (!target || typeof OBR?.action?.getHeight !== "function" ||
      typeof OBR?.action?.setHeight !== "function") return null;
  try {
    const current = await OBR.action.getHeight();
    if (Number.isFinite(current) && current <= target + 8) {
      return { target, current, changed: false };
    }
    await OBR.action.setHeight(target);
    return { target, current, changed: true };
  } catch (error) {
    console.warn("[gugu-cloud] 无法调整 Owlbear 移动弹窗高度，仍可使用翻页按钮", error);
    return { target, changed: false, error: true };
  }
}

/**
 * 原生 iOS iframe 触摸滚动失效时的备用入口。
 * 点击顶部翻页按钮直接修改本 iframe .main.scrollTop，不依赖父页面手势。
 */
export function jumpScroll(main, fraction = 0.65) {
  if (!main) return { changed: false, atBottom: false, max: 0 };
  const max = Math.max(0, main.scrollHeight - main.clientHeight);
  if (max <= 1) return { changed: false, atBottom: true, max };
  const current = main.scrollTop;
  const atBottom = current >= max - 5;
  const target = atBottom ? 0 : Math.min(max, current + Math.max(140, main.clientHeight * fraction));
  main.scrollTop = target;
  return { changed: Math.abs(main.scrollTop - current) > 1,
    atBottom: main.scrollTop >= max - 5, max };
}

/**
 * 给「Safari 原生滚动确实没启动」的后备滚动补上一段减速滑行。
 *
 * 这里用的是像素/毫秒的速度，手指松开后按指数规律衰减：
 *   v(t) = v0 * exp(-t / τ)，τ=300ms 左右。
 * 这样松手后还能自然滑行一小段，而且每一帧的位移会逐渐减小。
 * 顶部/底部到达边界后立即停下；下一次 touchstart 会同步调用 stop()
 * 取消上一段动画，模拟 iPhone「按住即可刹车」的操作体验。
 *
 * RAF 和时钟可以注入，便于自动测试减速与取消，而不依赖真实硬件帧率。
 */
export function createMomentumScroller(main, {
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (id) => cancelAnimationFrame(id),
} = {}) {
  let frame = null;
  let speed = 0;
  let previousTime = null;

  const stop = () => {
    if (frame !== null) cancelFrame(frame);
    frame = null;
    speed = 0;
    previousTime = null;
  };
  const animate = (time) => {
    frame = null;
    const dt = previousTime === null ? 16.7 :
      Math.max(1, Math.min(50, time - previousTime));
    previousTime = time;
    const decay = Math.exp(-dt / 310);
    // 使用指数积分而非速度*dt：高刷/低刷屏幕的滑动距离更接近。
    const distance = speed * 310 * (1 - decay);
    const max = Math.max(0, main.scrollHeight - main.clientHeight);
    const next = Math.max(0, Math.min(max, main.scrollTop + distance));
    const moved = Math.abs(next - main.scrollTop);
    main.scrollTop = next;
    speed *= decay;
    // 一旦顶到滚动边界就停止，不要徒劳继续预约 RAF 帧。
    if (moved < 0.15 || Math.abs(speed) < 0.025 ||
        (next >= max && speed > 0) || (next <= 0 && speed < 0)) return stop();
    frame = requestFrame(animate);
  };
  const start = (releaseVelocity) => {
    stop();
    if (!Number.isFinite(releaseVelocity) || Math.abs(releaseVelocity) < 0.07 ||
        main.scrollHeight - main.clientHeight <= 1) return false;
    speed = Math.max(-2.4, Math.min(2.4, releaseVelocity));
    frame = requestFrame(animate);
    return true;
  };
  return { start, stop, get running() { return frame !== null; } };
}

/**
 * iOS Safari 在某些跨域 iframe/宿主裁剪组合中，touchmove 已送到页面，
 * 但原生 overflow 滚动并未启动。先给原生滚动至少两个 touchmove 事件
 * 的机会；只有手指移动 >=14px 且 scrollTop 仍未变化时才接管拖动。
 * 手动接管后会跟手移动，并在松手时用实际位移速度启动惯性衰减。
 * 如果 Safari 已开始原生滚动，绝不双倍推进，也不会自行补惯性。
 * 跳过按钮、音量滑块和进度条等交互控件，避免破坏点击/拖动操作。
 */
export function installIosTouchScroll(main, userAgent = "", options = {}) {
  if (!main || !/iPhone|iPad|iPod/i.test(userAgent)) return () => {};
  let gesture = null;
  const momentum = createMomentumScroller(main, options);
  const clock = options.now || (() => performance.now());
  const interactive = 'button,a,input,textarea,select,[contenteditable],[data-act="seek"],.progress,.vol';
  const onStart = (event) => {
    // 不论是否点到输入控件，手指重新按下都要立刻终止上一次惯性。
    momentum.stop();
    const touch = event.touches?.[0];
    if (event.touches?.length !== 1 || !touch ||
        event.target?.closest?.(interactive)) {
      gesture = null;
      return;
    }
    gesture = { startY: touch.clientY, startTop: main.scrollTop,
      manual: false, native: false, moveCount: 0,
      lastTop: main.scrollTop, lastTime: clock(), velocity: 0 };
  };
  const onMove = (event) => {
    if (!gesture || event.touches?.length !== 1 || gesture.native) return;
    const max = main.scrollHeight - main.clientHeight;
    if (max <= 1) return;
    const delta = gesture.startY - event.touches[0].clientY;
    gesture.moveCount++;
    if (!gesture.manual) {
      if (Math.abs(main.scrollTop - gesture.startTop) > 2) {
        gesture.native = true;
        return;
      }
      if (Math.abs(delta) < 14 || gesture.moveCount < 2) return;
      gesture.manual = true;
    }
    const next = Math.max(0, Math.min(max, gesture.startTop + delta));
    const previous = main.scrollTop;
    if (Math.abs(next - previous) > 0.5) {
      main.scrollTop = next;
      if (event.cancelable) event.preventDefault();
    }
    // 采样实际滚动位移，不直接使用指尖位移；避免滚动边界产生超大速度。
    const time = clock();
    const dt = Math.max(1, time - gesture.lastTime);
    const instant = Math.max(-2.4, Math.min(2.4, (main.scrollTop - gesture.lastTop) / dt));
    gesture.velocity = gesture.velocity === 0 ? instant :
      0.62 * instant + 0.38 * gesture.velocity;
    gesture.lastTime = time;
    gesture.lastTop = main.scrollTop;
  };
  const onEnd = () => {
    if (gesture?.manual && clock() - gesture.lastTime < 110) {
      momentum.start(gesture.velocity);
    }
    gesture = null;
  };
  const onCancel = () => { gesture = null; momentum.stop(); };
  main.addEventListener("touchstart", onStart, { passive: true });
  main.addEventListener("touchmove", onMove, { passive: false });
  main.addEventListener("touchend", onEnd, { passive: true });
  main.addEventListener("touchcancel", onCancel, { passive: true });
  return () => {
    momentum.stop();
    main.removeEventListener("touchstart", onStart);
    main.removeEventListener("touchmove", onMove);
    main.removeEventListener("touchend", onEnd);
    main.removeEventListener("touchcancel", onCancel);
  };
}
