/**
 * 在 Node 环境模拟两名 Owlbear 参与者，共享 room metadata 与 Broadcast。
 * 这验证“控制指令不走 DO”的 API 契约：只需模拟本地 WebSocket，
 * 变更传播仍应由 OBR 事件触发。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CloudBridge } from "../../public/cloud/bridge.js";
import { applyCommand, createState, METADATA_KEY } from "../../public/cloud/state.js";

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    setTimeout(() => { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }, 0);
  }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
}

test("启动时Owlbear首轮元数据为空，玩家随后可以补偿读取已存在的音乐会话", async () => {
  globalThis.location = new URL("https://music.zjhstudio.com/");
  globalThis.WebSocket = FakeWebSocket;
  let roomMetadata = {};
  let fetchCount = 0;
  const roomId = "merlin-v33-incognito";
  const player = new CloudBridge({
    room: { id: roomId,
      getMetadata: async () => { fetchCount++; return structuredClone(roomMetadata); },
      onMetadataChange: () => {},
    },
    player: { getRole: async () => "PLAYER", onChange: () => {} },
    broadcast: { onMessage: () => {}, sendMessage: async () => {} },
  }, roomId);
  try {
    await player.start();
    assert.equal(player.state, null);
    assert.equal(player.startupDiagnostics().metadataReads, 1);
    roomMetadata = { [METADATA_KEY]: createState("a".repeat(32)) };
    // 无需等真实2秒：测试直接触发有限的补偿重读接口；
    // 验证正常玩家恢复后 Relay 会读取同一份房间元数据。
    await player.refresh();
    assert.equal(player.state.secret, "a".repeat(32));
    assert.equal(player.startupDiagnostics().sessionReady, true);
    assert.equal(player.startupDiagnostics().lastReadHadMusic, true);
    assert.equal(fetchCount, 2);
  } finally {
    player.relay?.close();
    clearInterval(player.clockMaintenance);
  }
});

test("GM 控制歌单通过 OBR Metadata 传播，玩家无权修改，无播放 HTTP/DO 消息", async () => {
  globalThis.location = new URL("https://music.zjhstudio.com/");
  globalThis.WebSocket = FakeWebSocket;
  const store = { data: {}, metadataSubscribers: [], channels: new Map() };
  const make = (role) => ({
    room: {
      id: "room-test-123",
      getMetadata: async () => structuredClone(store.data),
      setMetadata: async (update) => {
        store.data = { ...store.data, ...structuredClone(update) };
        for (const cb of store.metadataSubscribers) cb(structuredClone(store.data));
      },
      onMetadataChange: (cb) => { store.metadataSubscribers.push(cb); },
    },
    player: { getRole: async () => role },
    broadcast: {
      onMessage: (channel, cb) => {
        const list = store.channels.get(channel) || [];
        list.push(cb); store.channels.set(channel, list);
      },
      sendMessage: async (channel, data) => {
        for (const cb of store.channels.get(channel) || []) cb({ data });
      },
    },
  });

  const gm = new CloudBridge(make("GM"), "room-test-123");
  const player = new CloudBridge(make("PLAYER"), "room-test-123");
  try {
    await gm.start();
    await player.start();
    // v2 懒初始化：最初仅看见插件不应向别人的房间无意义写入状态。
    assert.equal(gm.state, null);
    await gm.ensureRoomState();
    await player.refresh();
    assert.equal(gm.state.secret.length, 32);
    assert.equal(player.state.secret, gm.state.secret);
    assert.equal(gm.relay.url(), player.relay.url());

    const before = gm.getNow().playback.seq;
    const id = "first-song";
    await gm.change((s) => ({
      ...s, rev: s.rev + 1,
      playlist: [{ id, title: "测试音频", hash: "a".repeat(64), size: 1024 }],
    }));
    await gm.apiPost("/api/rooms/room-test-123/command", { type: "select", trackId: id });
    assert.equal(player.getNow().track.id, id);
    assert.equal(player.getNow().playback.playing, true);
    assert.ok(player.getNow().playback.seq > before);
    assert.deepEqual(player.relay.tracks[0].hash, "a".repeat(64));
    assert.equal(gm.getState().playlist[0].title, "测试音频");

    await assert.rejects(
      () => player.apiPost("/api/rooms/room-test-123/command", { type: "pause" }),
      /Owlbear 房主权限/
    );
    assert.equal(gm.state.playback.playing, true);
    // 没有产生 GET /now、SSE、心跳等 Node HTTP 请求。
    assert.equal(gm.relay.ws.sent.some((x) => typeof x === "string" && x.includes('"type":"play"')), false);
  } finally {
    gm.relay?.close();
    player.relay?.close();
  }
});

test("GM 从 PLAYER 升权后，接近16KB的复杂房间仍能创建分类与上传曲目", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.location = new URL("https://music.zjhstudio.com/");
  globalThis.WebSocket = FakeWebSocket;
  const files = new Map();
  const key = "com.other-extension/large-shared-settings";
  const roomMetadata = { [key]: "X".repeat(15700) };
  const callbacks = [];
  const changed = [];
  let role = "PLAYER";
  const host = {
    room: {
      id: "many-extensions-room",
      getMetadata: async () => structuredClone(roomMetadata),
      setMetadata: async (data) => {
        Object.assign(roomMetadata, structuredClone(data));
        assert.ok(new TextEncoder().encode(JSON.stringify(roomMetadata)).length < 16 * 1024,
          "必须遵守 Owlbear 整个房间 16KB 共享上限");
        callbacks.forEach((cb) => cb(structuredClone(roomMetadata)));
      },
      onMetadataChange: (cb) => callbacks.push(cb),
    },
    player: {
      getRole: async () => role,
      onChange: (cb) => changed.push(cb),
    },
    broadcast: { onMessage: () => {}, sendMessage: async () => {} },
  };
  globalThis.fetch = async (url, options = {}) => {
    const uri = new URL(url, globalThis.location);
    assert.equal(uri.pathname, "/room-state");
    const hash = uri.searchParams.get("hash");
    if (options.method === "POST") {
      files.set(hash, options.body);
      return new Response(null, { status: 204 });
    }
    const data = files.get(hash);
    return data ? new Response(data, { status: 200 }) :
      new Response("Not found", { status: 404 });
  };
  const gm = new CloudBridge(host, host.room.id);
  const player = new CloudBridge({
    ...host,
    player: { ...host.player, getRole: async () => "PLAYER" },
  }, host.room.id);
  try {
    await gm.start();
    await player.start();
    assert.equal(gm.state, null, "PLAYER 进入房间时不会错误创建歌单");
    role = "GM";
    changed.forEach((cb) => cb({ role }));
    // 创建分类：第一次写操作应该自动初始化；而不是报「房间歌单未创建」。
    await gm.apiPost("/api/rooms/test/command",
      { type: "folder", op: "create", name: "莱德斯" });
    assert.ok(gm.state.folders.includes("莱德斯"));
    assert.equal(roomMetadata[key], "X".repeat(15700), "不允许破坏其他扩展的原始数据");
    assert.equal(roomMetadata["com.zjhstudio.gugu-cloud/state"].v, 2);
    assert.ok(files.size >= 2, "DO 快照应存入空歌单和创建分类后的状态");
    await gm.change((s) => ({
      ...s, rev: s.rev + 1, playlist: [
        ...s.playlist, { id: "first-song", hash: "f".repeat(64),
          title: "由GM上传的曲目", size: 200_000, duration: 12.4 },
      ],
    }));
    await player.refresh();
    assert.equal(player.state.playlist.length, 1);
    assert.equal(player.state.folders.includes("莱德斯"), true);
    assert.ok(new TextEncoder().encode(JSON.stringify(roomMetadata)).length < 16 * 1024);
  } finally {
    gm.relay?.close();
    player.relay?.close();
    clearInterval(gm.clockMaintenance);
    clearInterval(player.clockMaintenance);
    globalThis.fetch = originalFetch;
  }
});

test("双 GM 是两台独立设备：播放时钟归属随实际操作的设备切换", async () => {
  globalThis.location = new URL("https://music.zjhstudio.com/");
  globalThis.WebSocket = FakeWebSocket;
  const store = { data: {}, subscribers: [], channels: [] };
  const owl = {
    room: {
      id: "two-real-gm-clients",
      getMetadata: async () => structuredClone(store.data),
      setMetadata: async (update) => {
        Object.assign(store.data, structuredClone(update));
        for (const listener of store.subscribers) listener(structuredClone(store.data));
      },
      onMetadataChange: (listener) => store.subscribers.push(listener),
    },
    player: { getRole: async () => "GM" },
    broadcast: {
      onMessage: (_channel, listener) => store.channels.push(listener),
      sendMessage: async (_channel, data) => {
        for (const listener of store.channels) listener({ data });
      },
    },
  };
  const desktop = new CloudBridge(owl, owl.room.id);
  const mobile = new CloudBridge(owl, owl.room.id);
  desktop.deviceId = "desktop-unique-clock-id";
  mobile.deviceId = "mobile-unique-clock-id";
  try {
    await desktop.start();
    await mobile.start();
    await desktop.change((state) => ({
      ...state, playlist: [{
        id: "song", hash: "c".repeat(64), size: 120_000,
        title: "12-second-loop", duration: 12.4,
      }], rev: state.rev + 1,
    }));
    await desktop.apiPost("/api/rooms/room/command", { type: "select", trackId: "song" });
    assert.equal(desktop.getNow().playback.clockId, desktop.deviceId);
    assert.equal(mobile.state.playback.clockId, desktop.deviceId);

    // 模拟 Android 的实际系统时钟比桌面快 30 秒。mobile.skew 存的是
    //「桌面时钟 - Android 时钟」，因此暂停时需先换算旧锚点，再写本地锚点。
    const realNow = Date.now;
    mobile.skew = -30_000;
    let paused;
    try {
      Date.now = () => realNow() + 30_000;
      paused = await mobile.apiPost("/api/rooms/room/command", { type: "pause" });
    } finally {
      Date.now = realNow;
    }
    assert.equal(paused.now.playback.clockId, mobile.deviceId);
    assert.equal(desktop.state.playback.clockId, mobile.deviceId);
    // 原本 30 秒的系统时钟差不应该表现为音频直接前进/倒退 30 秒。
    assert.ok(Math.abs(desktop.state.playback.position) < 2,
      "暂停位置不应因另一 GM 的系统时钟偏差而跳跃");
    assert.equal(desktop.state.playback.playing, false);
  } finally {
    desktop.relay?.close();
    mobile.relay?.close();
    clearInterval(desktop.clockMaintenance);
    clearInterval(mobile.clockMaintenance);
  }
});
