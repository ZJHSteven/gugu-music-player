/**
 * 真正的状态写入决策：普通房间一直用 Owlbear Metadata；
 * 当同一歌单增长到接近总16KiB限制时，自动迁移到DO快照指针。
 *
 * 这项测试防止历史上「在 addTrack 中先触发14KiB硬拒绝，
 * 从而根本没有机会进入自动快照」的回归。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CloudBridge } from "../../public/cloud/bridge.js";
import { addTrack } from "../../public/cloud/state.js";

class RelayMock {
  static OPEN = 1;
  constructor() {
    this.readyState = 0;
    setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0);
  }
  send() {}
  close() { this.readyState = 3; }
}

test("正常房间v1→满额房间v2 DO指针：歌单不丢且没有破坏其他插件", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.location = new URL("https://music.zjhstudio.com/");
  globalThis.WebSocket = RelayMock;
  const blobs = new Map();
  const metadata = { "another/extension": "Other extension data remain untouched" };
  const watchers = [];
  const room = {
    id: "transition-from-metadata-to-snapshot",
    getMetadata: async () => structuredClone(metadata),
    setMetadata: async (changes) => {
      Object.assign(metadata, structuredClone(changes));
      assert.ok(new TextEncoder().encode(JSON.stringify(metadata)).length <= 16 * 1024);
      for (const cb of watchers) cb(structuredClone(metadata));
    },
    onMetadataChange: (cb) => watchers.push(cb),
  };
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url, globalThis.location);
    assert.equal(path.pathname, "/room-state");
    const hash = path.searchParams.get("hash");
    if (options.method === "POST") {
      blobs.set(hash, options.body);
      return new Response(null, { status: 204 });
    }
    return blobs.has(hash) ? new Response(blobs.get(hash), { status: 200 }) :
      new Response("not found", { status: 404 });
  };
  const common = { room, broadcast: { onMessage: () => {},
    sendMessage: async () => {} } };
  const gm = new CloudBridge({
    ...common, player: { getRole: async () => "GM" },
  }, room.id);
  const player = new CloudBridge({
    ...common, player: { getRole: async () => "PLAYER" },
  }, room.id);
  try {
    await gm.start();
    await player.start();
    await gm.ensureRoomState();
    assert.equal(metadata["com.zjhstudio.gugu-cloud/state"].v, 1,
      "普通房间优先使用Owlbear原生歌单");
    assert.equal(blobs.size, 0, "普通房间不应无故使用DO持久存储");

    await gm.change((state) => {
      let next = state;
      for (let i = 0; i < 110; i++) {
        next = addTrack(next, {
          title: `一首音频歌单名称-${i}`,
          hash: "a".repeat(64), size: 200_000,
          mime: "audio/mpeg", duration: 12.4,
        });
      }
      return next;
    });
    await player.refresh();
    assert.equal(gm.state.playlist.length, 110);
    assert.equal(player.state.playlist.length, 110);
    assert.equal(metadata["com.zjhstudio.gugu-cloud/state"].v, 2,
      "接近16KiB时自动变成小型指针");
    assert.equal(metadata["another/extension"],
      "Other extension data remain untouched");
    assert.ok(blobs.size >= 1, "完整JSON快照存入DO");
    assert.ok(new TextEncoder().encode(JSON.stringify(metadata)).length < 1024,
      "迁移后只留下小指针；不能把其他扩展的数据清空");
  } finally {
    gm.relay?.close();
    player.relay?.close();
    clearInterval(gm.clockMaintenance);
    clearInterval(player.clockMaintenance);
    globalThis.fetch = oldFetch;
  }
});
