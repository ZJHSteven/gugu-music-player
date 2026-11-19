import test from "node:test";
import assert from "node:assert/strict";
import { makeDiagnosticReport } from "../../public/cloud/diagnostics.js";

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
