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
 * iOS Safari 在某些跨域 iframe/宿主裁剪组合中，touchmove 已送到页面，
 * 但原生 overflow 滚动并未启动。只有手指移动 >=14px 且 scrollTop
 * 仍未变化时才接管拖动；如果 Safari 已开始原生滚动，绝不双倍推进。
 * 跳过按钮、音量滑块和进度条等交互控件，避免破坏点击/拖动操作。
 */
export function installIosTouchScroll(main, userAgent = "") {
  if (!main || !/iPhone|iPad|iPod/i.test(userAgent)) return () => {};
  let gesture = null;
  const interactive = 'button,a,input,textarea,select,[contenteditable],[data-act="seek"],.progress,.vol';
  const onStart = (event) => {
    const touch = event.touches?.[0];
    if (event.touches?.length !== 1 || !touch ||
        event.target?.closest?.(interactive)) {
      gesture = null;
      return;
    }
    gesture = { startY: touch.clientY, startTop: main.scrollTop,
      manual: false, native: false };
  };
  const onMove = (event) => {
    if (!gesture || event.touches?.length !== 1 || gesture.native) return;
    const max = main.scrollHeight - main.clientHeight;
    if (max <= 1) return;
    const delta = gesture.startY - event.touches[0].clientY;
    if (!gesture.manual) {
      if (Math.abs(main.scrollTop - gesture.startTop) > 2) {
        gesture.native = true;
        return;
      }
      if (Math.abs(delta) < 14) return;
      gesture.manual = true;
    }
    const next = Math.max(0, Math.min(max, gesture.startTop + delta));
    if (Math.abs(next - main.scrollTop) > 0.5) {
      main.scrollTop = next;
      if (event.cancelable) event.preventDefault();
    }
  };
  const onEnd = () => { gesture = null; };
  main.addEventListener("touchstart", onStart, { passive: true });
  main.addEventListener("touchmove", onMove, { passive: false });
  main.addEventListener("touchend", onEnd, { passive: true });
  main.addEventListener("touchcancel", onEnd, { passive: true });
  return () => {
    main.removeEventListener("touchstart", onStart);
    main.removeEventListener("touchmove", onMove);
    main.removeEventListener("touchend", onEnd);
    main.removeEventListener("touchcancel", onEnd);
  };
}
