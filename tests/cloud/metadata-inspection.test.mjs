import test from "node:test";
import assert from "node:assert/strict";
import { CloudBridge } from "../../public/cloud/bridge.js";
import { inspectRoomMetadata, estimatePointerRoomBytes,
  anonymousRoomCode } from "../../public/cloud/metadata-inspection.js";
import { METADATA_KEY } from "../../public/cloud/state.js";

class FakeWebSocket {
  static OPEN = 1;
  constructor() {
    this.readyState = 0;
    setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0);
  }
  send() {}
  close() { this.readyState = 3; }
}

test("匿名房间比对码同房间稳定、不同房间不同且不公开原始roomId", async () => {
  const id = "room-secret-original";
  const a = await anonymousRoomCode(id);
  assert.match(a, /^[a-f0-9]{12}$/);
  assert.equal(a, await anonymousRoomCode(id));
  assert.notEqual(a, await anonymousRoomCode(id + "B"));
  assert.ok(!a.includes(id));
});

test("其他扩展占用近16KiB时，诊断区分可放下最小指针与完全放不下", () => {
  const near = inspectRoomMetadata({ "other/ext": "X".repeat(16160) }, METADATA_KEY);
  assert.equal(near.musicKeyPresent, false);
  assert.equal(near.musicValueKind, "missing");
  assert.equal(near.totalBytes, 16176);
  assert.equal(near.pointerRoomBytes, 16343);
  assert.equal(near.pointerFits, true);
  const full = inspectRoomMetadata({ "other/ext": "X".repeat(16300) }, METADATA_KEY);
  assert.equal(full.totalBytes, 16316);
  assert.equal(full.pointerRoomBytes, 16483);
  assert.equal(full.pointerFits, false);
  assert.equal(full.freeBytes, 68);
});

test("其他扩展先占满16KiB：GM必须在写DO前报错，不创建孤儿快照", async () => {
  globalThis.location = new URL("https://music.zjhstudio.com/");
  globalThis.WebSocket = FakeWebSocket;
  const oldFetch = globalThis.fetch;
  let writesToDO = 0;
  let writesToOBR = 0;
  const existing = { "other/ext": "X".repeat(16300) };
  globalThis.fetch = async () => { writesToDO++; return new Response(null, { status: 204 }); };
  const gm = new CloudBridge({
    room: { id: "filled-room",
      getMetadata: async () => structuredClone(existing),
      setMetadata: async () => { writesToOBR++; },
      onMetadataChange: () => {},
    },
    player: { getRole: async () => "GM" },
    broadcast: { onMessage: () => {}, sendMessage: async () => {} },
  }, "filled-room");
  try {
    await gm.start();
    await assert.rejects(() => gm.ensureRoomState(), /快照指针|Owlbear总上限/);
    assert.equal(writesToDO, 0);
    assert.equal(writesToOBR, 0);
    assert.equal(gm.state, null);
    assert.equal(gm.startupDiagnostics().lastWriteStage, "pointer-capacity");
    assert.equal(gm.startupDiagnostics().writeFailures, 1);
    assert.equal(gm.startupDiagnostics().pointerFits, false);
  } finally {
    clearInterval(gm.clockMaintenance);
    gm.relay?.close();
    globalThis.fetch = oldFetch;
  }
});

test("其他扩展接近16KiB但还留得下指针：GM能够先写DO再发布指针", async () => {
  globalThis.location = new URL("https://music.zjhstudio.com/");
  globalThis.WebSocket = FakeWebSocket;
  const oldFetch = globalThis.fetch;
  let doWrites = 0;
  let metadata = { "other/ext": "X".repeat(16160) };
  globalThis.fetch = async () => { doWrites++; return new Response(null, { status: 204 }); };
  const gm = new CloudBridge({
    room: { id: "near-full-room",
      getMetadata: async () => structuredClone(metadata),
      setMetadata: async (changes) => {
        const merged = { ...metadata, ...structuredClone(changes) };
        assert.ok(new TextEncoder().encode(JSON.stringify(merged)).byteLength <= 16*1024);
        metadata = merged;
      },
      onMetadataChange: () => {},
    },
    player: { getRole: async () => "GM" },
    broadcast: { onMessage: () => {}, sendMessage: async () => {} },
  }, "near-full-room");
  try {
    await gm.start();
    await gm.ensureRoomState();
    assert.equal(metadata[METADATA_KEY].v, 2);
    assert.equal(doWrites, 1);
    assert.equal(gm.state.rev, 1);
    assert.equal(gm.startupDiagnostics().lastWriteStage, "success");
    assert.equal(estimatePointerRoomBytes(metadata, METADATA_KEY, 1) <= 16384, true);
  } finally {
    clearInterval(gm.clockMaintenance);
    gm.relay?.close();
    globalThis.fetch = oldFetch;
  }
});
