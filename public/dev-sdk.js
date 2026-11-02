// 本地预览用的假 OBR：只在 ?dev=1 时加载。
// http://localhost:8787/?dev=1&role=GM&room=devroom
const params = new URLSearchParams(location.search);
const role = params.get("role") === "PLAYER" ? "PLAYER" : "GM";
const roomId = params.get("room") || "devroom";
const me = { id: `dev-${role.toLowerCase()}`, role, name: role === "GM" ? "地下城主" : "玩家" };

export default {
  isReady: true,
  onReady: (cb) => setTimeout(cb, 0),
  room: { id: roomId },
  player: {
    id: me.id,
    getRole: async () => role,
    getName: async () => me.name,
    onChange: (cb) => {
      setTimeout(() => cb(me), 0);
      return () => {};
    },
  },
  notification: { show: async (msg) => console.log("[dev notify]", msg) },
};
