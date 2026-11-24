import test from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { Blob } from "node:buffer";
import { CloudBridge } from "../../public/cloud/bridge.js";
import { createBackupArchive } from "../../public/cloud/backup.js";
import { createState, addTrack, applyCommand } from "../../public/cloud/state.js";
import { validatePlaylist, verifyCachedAudio, describeLocalAudio } from "../../public/cloud/source-health.js";
import { RelayClient } from "../../public/cloud/relay-client.js";

globalThis.crypto ??= webcrypto;
globalThis.location = new URL("https://music.zjhstudio.com/");
const sha = (b) => createHash("sha256").update(b).digest("hex");

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  constructor() {
    this.readyState = 0;
    this.sent = [];
    setTimeout(() => {
      if (this.readyState === 0) {
        this.readyState = 1;
        this.onopen?.();
      }
    }, 0);
  }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
}
globalThis.WebSocket = FakeWebSocket;

function makeBridge(state, role = "GM") {
  const room = { data: { "com.zjhstudio.gugu-cloud/state": state }, changes: [] };
  const messages = [];
  const recipients = [];
  const bridge = new CloudBridge({
    room: {
      getMetadata: async () => structuredClone(room.data),
      setMetadata: async (patch) => {
        Object.assign(room.data, structuredClone(patch));
        for (const cb of room.changes) cb(structuredClone(room.data));
      },
      onMetadataChange: cb => room.changes.push(cb),
    },
    player: { getRole: async () => role, onChange: () => {} },
    broadcast: {
      onMessage: (_, callback) => recipients.push(callback),
      sendMessage: async (_, data) => {
        messages.push(data);
        for (const callback of recipients) callback({ data });
      },
    },
  }, "source-audit-test-room");
  return { bridge, room, messages };
}

const cleanup = (bridge) => {
  bridge.relay?.close();
  clearInterval(bridge.clockMaintenance);
};

test("GM 启动时拒绝损坏的歌单结构，但缺少本地原文件不删除其他曲目", async () => {
  let state = createState("a".repeat(32));
  state = addTrack(state, { title: "可单独修复", hash: "b".repeat(64), size: 128 });
  assert.equal(validatePlaylist(state), true);
  const invalid = structuredClone(state);
  invalid.playlist.push({ ...invalid.playlist[0] });
  assert.throws(() => validatePlaylist(invalid), /歌单第 2 首/);
  const invalidHash = structuredClone(state);
  invalidHash.playlist[0].hash = "not-a-hash";
  assert.throws(() => validatePlaylist(invalidHash), /元数据损坏/);

  const { bridge } = makeBridge(state);
  try {
    await bridge.start();
    await bridge.relay.updateTracks(state.playlist);
    assert.deepEqual(bridge.audioHealth.localMissing, ["b".repeat(64)]);
    assert.equal(bridge.state.playlist.length, 1);
    assert.equal(bridge.state.playlist[0].title, "可单独修复");
  } finally { cleanup(bridge); }
});

test("房间 Metadata 结构损坏会产生可见故障状态，不被误当成空歌单", async () => {
  const state = createState("8".repeat(32));
  state.playlist.push({ id: "broken", title: "broken", hash: "wrong", size: -12 });
  const { bridge } = makeBridge(state);
  try {
    await bridge.start();
    assert.equal(bridge.state, null);
    assert.match(bridge.audioHealth.metadataError, /歌单.*校验失败/);
    assert.match(bridge.audioHealth.metadataError, /第 1 首/);
  } finally { cleanup(bridge); }
});

test("DO 暂时没有来源先等待：available 抵达能取消告警；确认缺失才通知 GM", async () => {
  const hash = "a".repeat(64);
  const events = [];
  const relay = new RelayClient("room", "a".repeat(32),
    () => {}, () => {}, event => events.push(event));
  relay.tracks = [{ hash, size: 100, title: "待获取" }];
  relay.ws = { readyState: FakeWebSocket.OPEN, send: () => {}, close: () => {} };
  try {
    relay.onControl(JSON.stringify({ t: "unavailable", hash }));
    assert.equal(events.some((event) => event.type === "unavailable"), false);
    relay.onControl(JSON.stringify({ t: "available", hashes: [hash] }));
    assert.equal(relay.unavailableTimers.size, 0);
    assert.equal(events.some((event) => event.type === "unavailable"), false);
    relay.onControl(JSON.stringify({ t: "unavailable", hash }));
    await new Promise((resolve) => setTimeout(resolve, 2600));
    assert.equal(events.filter((event) => event.type === "unavailable").length, 1);
  } finally { relay.close(); }
});

test("PLAYER 初次连接的 WebSocket onopen 不能覆盖未完成的歌单扫描，优先当前音轨", async () => {
  const relay = new RelayClient("race-room", "b".repeat(32));
  const tracks = [
    { id: "old", title: "第一首", hash: "1".repeat(64), size: 200 },
    { id: "current", title: "正在播放", hash: "2".repeat(64), size: 200 },
    { id: "next", title: "下一首", hash: "3".repeat(64), size: 200 },
  ];
  try {
    const initialScan = relay.updateTracks(tracks, "current");
    assert.equal(relay.desiredTracks.length, 3, "待同步歌单须在 await OPFS 之前保存");
    relay.connect();
    // 人为让 onopen 在首次扫描尚未结束时执行：旧实现从 this.tracks
    // （仍是空数组）重启扫描，最终 PLAYER 一首歌都不会请求。
    relay.ws.readyState = FakeWebSocket.OPEN;
    relay.ws.onopen();
    await initialScan;
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(relay.tracks.length, 3);
    assert.equal(relay.tracks[0].id, "current", "当前曲目必须优先");
    assert.equal(relay.desiredTracks.length, 3);
    assert.ok(relay.metrics.requested >= 1, "缺失音源时仍须实际发起获取请求");
  } finally { relay.close(); }
});

test("大歌单后续文件仍在核验时，当前和下一首已立即发出分块下载请求", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let releaseThird;
  const holdThird = new Promise((resolve) => { releaseThird = resolve; });
  const hashes = ["1".repeat(64), "2".repeat(64), "3".repeat(64), "4".repeat(64)];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { storage: {
      getDirectory: async () => ({
        getDirectoryHandle: async () => ({
          getFileHandle: async (hash) => {
            if (hash === hashes[3]) await holdThird;
            throw new Error("本机未缓存");
          },
        }),
      }),
    } },
  });
  const relay = new RelayClient("priority-room", "b".repeat(32));
  const outbound = [];
  relay.ws = { readyState: FakeWebSocket.OPEN,
    send: (message) => outbound.push(JSON.parse(message)),
    close: () => {} };
  try {
    const scan = relay.updateTracks(hashes.map((hash, index) =>
      ({ id: String(index), hash, title: String(index), size: 128 })), "1");
    for (let i = 0; i < 20 && outbound.filter((m) => m.t === "need").length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(outbound.filter((m) => m.t === "need").map((m) => m.hash),
      [hashes[1], hashes[2]], "当前（索引1）与下一首（索引2）应抢在历史曲目之前");
    assert.equal(relay.tracks.length, 2, "全量审计还没完成，但优先批次已开始下载");
    releaseThird();
    await scan;
    assert.equal(relay.tracks.length, 4);
  } finally {
    releaseThird();
    relay.close();
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else delete globalThis.navigator;
  }
});

test("来源缺失广播只提醒：不能改歌单；找到新来源会同步清除房主告警", async () => {
  let state = createState("9".repeat(32));
  state = addTrack(state, { title: "告警曲", hash: "7".repeat(64), size: 25 });
  const { bridge, messages } = makeBridge(state);
  try {
    await bridge.start();
    const before = structuredClone(bridge.state);
    bridge.onAudioAvailability({ type: "unavailable", hash: state.playlist[0].hash });
    assert.ok(messages.some((message) => message.t === "audio-unavailable"));
    assert.deepEqual(bridge.state, before);
    assert.deepEqual(bridge.audioHealth.remoteMissing, [state.playlist[0].hash]);
    bridge.onAudioAvailability({ type: "source-found", hash: state.playlist[0].hash });
    assert.deepEqual(bridge.audioHealth.remoteMissing, []);
    assert.ok(messages.some((message) => message.t === "audio-available"));
    assert.deepEqual(bridge.state, before);
  } finally { cleanup(bridge); }
});

test("本机原文件分别验证字节长度和 SHA256，不把损坏的 OPFS 文件当音源", async () => {
  const bytes = Buffer.from("valid audio source data");
  const hash = sha(bytes);
  const t = { hash, size: bytes.length };
  const reader = async () => new Blob([bytes]);
  const digest = async (b) => sha(Buffer.from(await b.arrayBuffer()));
  assert.deepEqual(await verifyCachedAudio(t, reader, digest), { valid: true, reason: null });
  assert.deepEqual(await verifyCachedAudio(t, async () => null, digest), { valid: false, reason: "missing" });
  assert.deepEqual(await verifyCachedAudio(t, async () => new Blob(["short"]), digest),
    { valid: false, reason: "size-mismatch" });
  assert.deepEqual(await verifyCachedAudio(t, async () => new Blob(["x".repeat(bytes.length)]), digest),
    { valid: false, reason: "hash-mismatch" });
});

test("重命名只改 Metadata，不改变音频哈希、播放序号和原有时间锚点", async () => {
  let state = createState("c".repeat(32));
  state = addTrack(state, { title: "原名", hash: "d".repeat(64), size: 123, duration: 30 });
  state = applyCommand(state, { type: "select", trackId: state.playlist[0].id });
  const original = structuredClone(state.playback);
  const { bridge } = makeBridge(state);
  try {
    await bridge.start();
    await bridge.apiPost("/api/rooms/test/command", {
      type: "track.update", trackId: state.playlist[0].id, patch: { title: "  新歌名  " },
    });
    assert.equal(bridge.state.playlist[0].title, "新歌名");
    assert.equal(bridge.state.playlist[0].hash, state.playlist[0].hash);
    assert.deepEqual(bridge.state.playback, original);
    assert.throws(() => applyCommand(bridge.state, {
      type: "track.update", trackId: state.playlist[0].id, patch: { title: "   " },
    }), /不能为空/);
  } finally { cleanup(bridge); }
});

test("原版一致自动补传；SHA-256 不匹配先警告，只有确认后安全替换版本", async () => {
  const bytes = Buffer.from("this is one full original audio");
  const hash = sha(bytes);
  let state = createState("e".repeat(32));
  state = addTrack(state, { title: "缺失的音轨", hash, size: bytes.length });
  state = addTrack(state, { title: "另一首", hash: "f".repeat(64), size: 222 });
  const { bridge, messages } = makeBridge(state);
  try {
    await bridge.start();
    await bridge.relay.updateTracks(state.playlist);
    const before = structuredClone(bridge.state);
    const replacement = new Blob([Buffer.from("x".repeat(bytes.length))]);
    const warning = await bridge.repairTrack(state.playlist[0].id, replacement);
    assert.equal(warning.needsConfirmation, true);
    assert.equal(warning.newHash, sha(Buffer.from("x".repeat(bytes.length))));
    assert.equal(bridge.state.playlist[0].hash, hash, "警告阶段不能偷偷改歌单");
    assert.equal(bridge.state.rev, before.rev, "警告阶段不写 Metadata");
    await assert.rejects(() => bridge.repairTrack(state.playlist[0].id, replacement, {
      confirmVersionChange: true, expectedOldHash: "0".repeat(64),
      approvedNewHash: warning.newHash,
    }), /版本.*变化/);
    assert.equal(bridge.state.playlist[0].hash, hash);
    assert.equal(bridge.state.playlist.length, 2);
    const repaired = await bridge.repairTrack(state.playlist[0].id, new Blob([bytes]));
    assert.ok(["opfs", "indexeddb", "memory"].includes(repaired.savedTo));
    assert.equal(bridge.state.rev, before.rev, "单曲补传不得意外修改歌单 Revision");
    assert.deepEqual(bridge.state.playback, before.playback);
    assert.equal(bridge.audioHealth.localMissing.includes(hash), false);
    assert.equal(bridge.audioHealth.localMissing.includes("f".repeat(64)), true);
    assert.ok(messages.some((msg) => msg.t === "audio-available" && msg.hash === hash));
    const originalPlayback = structuredClone(bridge.state.playback);
    const overridden = await bridge.repairTrack(state.playlist[0].id, replacement, {
      confirmVersionChange: true,
      expectedOldHash: warning.oldHash,
      approvedNewHash: warning.newHash,
      duration: 13,
    });
    assert.equal(overridden.changedVersion, true);
    assert.equal(bridge.state.playlist[0].hash, warning.newHash);
    assert.equal(bridge.state.playlist[0].size, replacement.size);
    assert.equal(bridge.state.playlist[0].duration, 13);
    assert.deepEqual(bridge.state.playback, originalPlayback);
    assert.equal(bridge.state.playlist.length, 2, "替换版本不能新建重复歌");
    assert.equal(bridge.state.playlist[1].hash, "f".repeat(64), "其他歌曲必须保持不变");
    assert.ok(messages.some((msg) => msg.t === "audio-available" && msg.hash === warning.newHash));
  } finally { cleanup(bridge); }
});

test("ZIP 恢复按哈希补原文件：旧标题不重复加歌；同名不同哈希报告不匹配", async () => {
  const a = Buffer.from("zip-matched-original-song");
  const c = Buffer.from("zip-new-song");
  const d = Buffer.from("zip-conflict-different-audio");
  const ha = sha(a), hc = sha(c), hd = sha(d);
  let state = createState("3".repeat(32));
  state = addTrack(state, { title: "已手动更名", hash: ha, size: a.length });
  state = addTrack(state, { title: "冲突曲名", hash: "4".repeat(64), size: 111 });
  const zip = await createBackupArchive([
    { title: "备份里的旧名", hash: ha, size: a.length, duration: 1 },
    { title: "新曲目", hash: hc, size: c.length, duration: 2 },
    { title: "冲突曲名", hash: hd, size: d.length, duration: 3 },
  ], new Map([
    [ha, new Blob([a])], [hc, new Blob([c])], [hd, new Blob([d])],
  ]));
  const { bridge } = makeBridge(state);
  try {
    await bridge.start();
    const result = await bridge.importBackup(zip);
    assert.equal(result.restored, 2);
    assert.equal(result.added, 1);
    assert.deepEqual(result.mismatched, ["冲突曲名"]);
    assert.deepEqual(result.stillMissing, ["冲突曲名"]);
    assert.equal(bridge.state.playlist.length, 3);
    assert.equal(bridge.state.playlist[0].title, "已手动更名");
    assert.equal(bridge.state.playlist.filter((t) => t.hash === ha).length, 1);
  } finally { cleanup(bridge); }
});

test("多 GM 设备是独立缓存：本机待同步并不等于音频源文件永久丢失", () => {
  const hash = "5".repeat(64);
  assert.deepEqual(describeLocalAudio(hash, { localMissing: [hash] }),
    { status: "pending", label: "本机待同步" });
  assert.deepEqual(describeLocalAudio(hash, { localMissing: [hash], fetching: [hash] }),
    { status: "fetching", label: "正在同步" });
  assert.deepEqual(describeLocalAudio(hash, { localMissing: [hash], unavailable: [hash] }),
    { status: "offline", label: "等待音源设备上线" });
  assert.deepEqual(describeLocalAudio(hash, { localMissing: [hash],
    corrupt: [{ hash, reason: "hash-mismatch" }] }),
    { status: "corrupt", label: "本机缓存校验异常" });
  assert.equal(describeLocalAudio(hash, { localMissing: [] }), null);
});

test("同账号另一台设备上线后，已判暂无来源的本机自动重新请求文件", async () => {
  const hash = "6".repeat(64);
  const sent = [];
  const events = [];
  const relay = new RelayClient("multi-gm-test", "b".repeat(32), () => {}, () => {},
    (event) => events.push(event));
  relay.ws = { readyState: FakeWebSocket.OPEN,
    send: (data) => sent.push(JSON.parse(data)), close: () => {} };
  try {
    await relay.updateTracks([{ id: "song", title: "另一台 GM 有原件", hash, size: 100 }]);
    assert.equal(sent.filter((m) => m.t === "need" && m.hash === hash).length, 1);
    relay.onControl(JSON.stringify({ t: "unavailable", hash }));
    assert.ok(relay.unavailable.has(hash));
    relay.onControl(JSON.stringify({ t: "available", hashes: [hash] }));
    assert.ok(!relay.unavailable.has(hash));
    assert.equal(sent.filter((m) => m.t === "need" && m.hash === hash).length, 2,
      "存有音频的电脑/其他 GM 上线公告后，手机应自动重新取文件");
    assert.ok(events.some((e) => e.type === "source-found" && e.hash === hash));
  } finally { relay.close(); }
});

test("GM 拖动歌单后跨端元数据顺序更新，但不改变现有播放时钟", async () => {
  let state = createState("7".repeat(32));
  for (let n = 0; n < 3; n++) {
    state = addTrack(state, { title: "歌曲" + n,
      hash: String(n + 1).repeat(64), size: 100 + n, duration: 25 });
  }
  state = applyCommand(state, { type: "select", trackId: state.playlist[1].id });
  const playback = structuredClone(state.playback);
  const firstId = state.playlist[0].id;
  const { bridge } = makeBridge(state);
  try {
    await bridge.start();
    const result = await bridge.apiPost("/api/rooms/test/command",
      { type: "playlist", op: "move", from: 0, to: 2 });
    assert.deepEqual(result.state.playlist.map((t) => t.title),
      ["歌曲1", "歌曲2", "歌曲0"]);
    assert.deepEqual(result.state.playback, playback);
    assert.equal(result.state.playlist[2].id, firstId);
    const noOp = await bridge.apiPost("/api/rooms/test/command",
      { type: "playlist", op: "move", from: 1, to: 1 });
    assert.equal(noOp.state.rev, result.state.rev, "未改变顺序不应产生新修订");
  } finally { cleanup(bridge); }
});

test("建分类和移动歌曲到分类只修改元数据，播放进度不被重置", async () => {
  let state=createState("d".repeat(32));
  state=addTrack(state,{title:"持续播放的曲目",hash:"8".repeat(64),size:100,duration:30});
  state=applyCommand(state,{type:"select",trackId:state.playlist[0].id});
  const playback=structuredClone(state.playback);
  const {bridge}=makeBridge(state);
  try {
    await bridge.start();
    await bridge.apiPost("/api/rooms/test/command",
      {type:"folder",op:"create",name:"新的分类"});
    assert.deepEqual(bridge.state.playback,playback);
    await bridge.apiPost("/api/rooms/test/command",
      {type:"track.folder",trackId:state.playlist[0].id,folder:"新的分类"});
    assert.deepEqual(bridge.state.playback,playback);
    assert.equal(bridge.state.playlist[0].folder,"新的分类");
  } finally {cleanup(bridge);}
});
