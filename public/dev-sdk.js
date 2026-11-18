/**
 * 仅供 ?dev=1 使用的 Owlbear 本地替身。
 *
 * 原版只提供玩家角色和房间 ID，无法在真实浏览器里验收新的 Room Metadata /
 * Broadcast 云端播放架构。这个替身实现最小的同源跨标签页事件通道：
 * - 房间元数据写入 localStorage（只存歌单、时间锚点，不存音频）
 * - BroadcastChannel 模拟 Owlbear 的房间广播
 * - 通过两个独立浏览器标签页分别带 role=GM 和 role=PLAYER 测试。
 *
 * 这是开发专用模拟器，不等于 Owlbear 真实房间集成测试。
 */
const params = new URLSearchParams(location.search);
const role = params.get("role") === "PLAYER" ? "PLAYER" : "GM";
const roomId = params.get("room") || "devroom";
const me = {
  id: `dev-${role.toLowerCase()}`,
  role,
  name: role === "GM" ? "开发主持人" : "开发玩家",
};
const metadataKey = `gugu-dev:room:${roomId}:metadata`;
const busName = `gugu-dev:room:${roomId}:bus`;
const bus = new BroadcastChannel(busName);
const metadataListeners = new Set();
const broadcastListeners = new Map();

function loadMetadata() {
  try {
    const value = localStorage.getItem(metadataKey);
    return value ? JSON.parse(value) : {};
  } catch { return {}; }
}

function emitMetadata() {
  const value = loadMetadata();
  for (const listener of metadataListeners) listener(value);
}

bus.onmessage = (event) => {
  const data = event.data;
  if (data?.type === "metadata") {
    emitMetadata();
  } else if (data?.type === "broadcast") {
    for (const listener of broadcastListeners.get(data.channel) || []) {
      listener({ data: data.message, playerId: data.playerId });
    }
  }
};

export default {
  isReady: true,
  onReady: (cb) => setTimeout(cb, 0),
  room: {
    id: roomId,
    getMetadata: async () => loadMetadata(),
    setMetadata: async (update) => {
      // Owlbear 的 setMetadata 是局部字段合并：避免删除其他扩展的数据。
      const merged = { ...loadMetadata(), ...update };
      localStorage.setItem(metadataKey, JSON.stringify(merged));
      emitMetadata();
      bus.postMessage({ type: "metadata" });
    },
    onMetadataChange: (listener) => {
      metadataListeners.add(listener);
      return () => metadataListeners.delete(listener);
    },
  },
  player: {
    id: me.id,
    getRole: async () => role,
    getName: async () => me.name,
    onChange: (cb) => {
      setTimeout(() => cb(me), 0);
      return () => {};
    },
  },
  broadcast: {
    onMessage: (channel, listener) => {
      let set = broadcastListeners.get(channel);
      if (!set) broadcastListeners.set(channel, (set = new Set()));
      set.add(listener);
      return () => set.delete(listener);
    },
    sendMessage: async (channel, message) => {
      bus.postMessage({ type: "broadcast", channel, message, playerId: me.id });
    },
  },
  notification: {
    show: async (message) => console.log("[OBR dev notification]", message),
  },
};
