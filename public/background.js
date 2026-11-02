// 后台引擎入口（manifest 的 background_url）。负责真正发声，浮窗只做界面。
import { initOBR } from "./lib.js";
import { Engine } from "./engine.js";

async function main() {
  const { OBR, role, roomId, attempts } = await initOBR();
  if (!roomId) return console.warn("[bard] 没有房间号，后台引擎不启动");

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

main().catch((err) => console.error("[bard] 后台引擎启动失败", err));
