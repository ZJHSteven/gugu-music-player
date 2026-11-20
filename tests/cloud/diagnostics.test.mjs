import test from "node:test";
import assert from "node:assert/strict";
import { makeDiagnosticReport } from "../../public/cloud/diagnostics.js";
import { CLOUD_RELEASE_VERSION } from "../../public/cloud/release-version.js";

test("报告可见下载、播放器、服务器状态但不会泄露房间密钥与歌名", () => {
  const secret = "a".repeat(32);
  const room = "PRIVATE-ROOM-SECRET-PLACE";
  const text = makeDiagnosticReport({
    userAgent: "Mozilla/5.0 (Android) Firefox/160.0",
    role: "PLAYER", hasMusicSession: true, trackLoaded: true,
    revision: 7, trackDuration: 12.4, playingInRoom: true,
    roomId: room, secret, title: "PRIVATE-SONG",
    engine: { engineKind: "background",
      media: { paused: true, blocked: true, errorName: "NotAllowedError",
        readyState: 0, networkState: 3 },
      relay: { connected: true, peer: "abcdef123456789", ownedCount: 0,
        requestedCount: 1, files: [{ hash: "fffffffffffffffffff",
          expectedBytes: 2188046, receivedBytes: 2097152, cached: false }] },
    },
    server: { connections: 3, roomId: room, secret, clients: [
      { peer: "abcdef123456789", forwardedBytes: 2097152,
        verifiedCount: 0, secret, playerName: "PRIVATE-PLAYER" },
    ] },
  });
  assert.match(text, /NotAllowedError/);
  assert.match(text, /2097152/);
  assert.match(text, /abcdef123456/);
  assert.match(text, /Android/);
  assert.doesNotMatch(text, new RegExp(secret));
  for (const data of [room, "PRIVATE-SONG", "PRIVATE-PLAYER"]) {
    assert.ok(!text.includes(data), "不能泄漏用户私密字段：" + data);
  }
});

test("iOS Chrome 浏览器标签、诊断版本和失败阶段与真实情况一致", () => {
  const text = makeDiagnosticReport({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) " +
      "AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/155.0 Mobile/15E148 Safari/604.1",
    engine: { relay: { events: [
      { type: "failure", at: "2026-11-19T17:56:00.000Z",
        phase: "integrity", reason: "hash-mismatch", hash: "6182290c3c" },
      { type: "verified", at: "2026-11-19T17:56:01.000Z",
        storage: "memory", bytes: 2188046 },
    ] } },
  });
  const report = JSON.parse(text.slice(text.indexOf("{")));
  assert.equal(report.version, CLOUD_RELEASE_VERSION);
  assert.equal(report.browser, "Chrome");
  assert.equal(report.system, "iOS/iPadOS");
  assert.equal(report.engine.kind, "unavailable");
  assert.equal(report.relayInAudioEngine.recentEvents[0].phase, "integrity");
  assert.equal(report.relayInAudioEngine.recentEvents[0].reason, "hash-mismatch");
  assert.equal(report.relayInAudioEngine.recentEvents[1].storage, "memory");
});

test("梅林无痕模式诊断能区分SDK就绪、房间身份与元数据未取得，不泄漏房间号", () => {
  const realRoomId = "ROOM-SECRET-MERLIN-ROOM-2026";
  const reportText = makeDiagnosticReport({
    role: "PLAYER", sdkReady: true, roomIdPresent: true, engineResponded: true,
    roomMetadata: { roomIdPresent: true, metadataReads: 2,
      metadataReadFailures: 1, metadataChangeEvents: 0, lastReadHadMusic: false,
      sessionReady: false, roomId: realRoomId },
    hasMusicSession: false, roomId: realRoomId,
  });
  const report = JSON.parse(reportText.slice(reportText.indexOf("{")));
  assert.equal(report.owlBearSdkReady, true);
  assert.equal(report.owlBearRoomIdPresent, true);
  assert.equal(report.audioEngineResponded, true);
  assert.equal(report.roomMetadata.metadataReads, 2);
  assert.equal(report.roomMetadata.lastReadHadMusic, false);
  assert.equal(report.roomMetadata.sessionReady, false);
  assert.equal(report.version, "3.2.8");
  assert.ok(!reportText.includes(realRoomId));
});
