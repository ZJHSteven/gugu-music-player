/**
 * Owlbear Rodeo SDK 的初始化保护。
 * 「角色未知」不是 PLAYER，「房间 ID 尚未获得」也不是空歌单。
 * 严格区分它们，防止玩家在 GM 正常播放时错误看到“没有音乐会话”。
 */
export function validateOwlbearIdentity({ ready, role, roomId }) {
  if (ready !== true) throw Object.assign(
    new Error("Owlbear SDK 尚未就绪"), { code: "SDK_NOT_READY" });
  if (role !== "GM" && role !== "PLAYER") throw Object.assign(
    new Error("Owlbear 尚未返回房间角色"), { code: "ROLE_UNAVAILABLE" });
  if (typeof roomId !== "string" || !roomId.trim()) throw Object.assign(
    new Error("Owlbear 尚未返回有效房间 ID"), { code: "ROOM_UNAVAILABLE" });
  return { role, roomId };
}

/**
 * 限制自动恢复次数：只在确实未能启动播放器时重新握手，不会因为
 * 网络长时间断开产生无限 reload 风暴。每个 iframe 自行限制。
 */
export function shouldRetryOwlbear(store, now = Date.now()) {
  const key = "gugu:obr:startup-retries";
  let previous = null;
  try { previous = JSON.parse(store.getItem(key) || "null"); } catch {}
  const count = previous && now - previous.at < 120_000 ? previous.count : 0;
  if (count >= 2) return { retry: false, count };
  try { store.setItem(key, JSON.stringify({ at: now, count: count + 1 })); } catch {}
  return { retry: true, count: count + 1, delay: count === 0 ? 2500 : 6000 };
}

export function resetOwlbearRetries(store) {
  try { store.removeItem("gugu:obr:startup-retries"); } catch {}
}
