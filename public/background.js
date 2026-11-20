// 后台引擎入口（manifest 的 background_url）。负责真正发声，浮窗只做界面。
import { initOBR } from "./lib.js";
import { Engine } from "./engine.js";
import { shouldRetryOwlbear, resetOwlbearRetries } from "./obr-identity.js";

async function main() {
  const { OBR, role, roomId, attempts } = await initOBR();
  try { resetOwlbearRetries(sessionStorage); } catch {}

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
  if (!["SDK_NOT_READY", "ROLE_UNAVAILABLE", "ROOM_UNAVAILABLE"].includes(err?.code)) return;
  // 后台也必须能从一次性 SDK 握手失败中恢复：最多自动刷新两次。
  try {
    const { retry, delay } = shouldRetryOwlbear(sessionStorage);
    if (retry) setTimeout(() => location.reload(), delay);
  } catch {
    // 某些无痕 iframe 禁止 sessionStorage，不因此制造新的异常风暴。
  }
});
