/**
 * 在 Node 环境模拟两名 Owlbear 参与者，共享 room metadata 与 Broadcast。
 * 这验证“控制指令不走 DO”的 API 契约：只需模拟本地 WebSocket，
 * 变更传播仍应由 OBR 事件触发。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CloudBridge } from "../../public/cloud/bridge.js";

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
