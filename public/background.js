// 后台引擎入口（manifest 的 background_url）。负责真正发声，浮窗只做界面。
import { initOBR } from "./lib.js";
import { Engine } from "./engine.js";
import { shouldRetryOwlbear, resetOwlbearRetries } from "./obr-identity.js";

async function main() {
  const { OBR, role, roomId, attempts } = await initOBR();
  resetOwlbearRetries(sessionStorage);

  const engine = new Engine({ OBR, role, roomId, kind: "background", attempts });
  await engine.start();

  OBR.player.onChange?.((p) => {
    if (p?.role && p.role !== engine.role) {
      engine.role = p.role;
      if (engine.role === "GM") engine.ensureOwner();
      engine.emitStatus();
    }
  });
}

main().catch((err) => {
  console.error("[bard] 后台引擎启动失败", err);
  // 在用户尚未进入任何音乐会话前才有限次刷新后台 iframe，
  // 这会让被 Owlbear 初始 postMessage 握手丢失的情况重新获得握手机会。
  if (!["SDK_NOT_READY", "ROLE_UNAVAILABLE", "ROOM_UNAVAILABLE"].includes(err.code)) return;
  const { retry, delay } = shouldRetryOwlbear(sessionStorage);
  if (retry) setTimeout(() => location.reload(), delay);
});
