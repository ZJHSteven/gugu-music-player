import test from "node:test";
import assert from "node:assert/strict";
import { validateOwlbearIdentity, shouldRetryOwlbear,
  resetOwlbearRetries } from "../../public/obr-identity.js";

test("SDK 未就绪、身份未知和缺少房间 ID 都不能默认为 PLAYER", () => {
  const valid = { ready: true, roomId: "room-id", role: "PLAYER" };
  assert.deepEqual(validateOwlbearIdentity(valid),
    { roomId: "room-id", role: "PLAYER" });
  assert.deepEqual(validateOwlbearIdentity({ ...valid, role: "GM" }),
    { roomId: "room-id", role: "GM" });
  assert.throws(() => validateOwlbearIdentity({ ...valid, ready: false }),
    { code: "SDK_NOT_READY" });
  assert.throws(() => validateOwlbearIdentity({ ...valid, role: null }),
    { code: "ROLE_UNAVAILABLE" });
  assert.throws(() => validateOwlbearIdentity({ ...valid, roomId: "" }),
    { code: "ROOM_UNAVAILABLE" });
});

test("错误握手只允许两次自动刷新，用户主动操作仍能再试", () => {
  const values = new Map();
  const store = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  assert.equal(shouldRetryOwlbear(store, 50_000).retry, true);
  assert.equal(shouldRetryOwlbear(store, 60_000).retry, true);
  assert.equal(shouldRetryOwlbear(store, 70_000).retry, false);
  resetOwlbearRetries(store);
  assert.equal(shouldRetryOwlbear(store, 70_100).retry, true);
});
