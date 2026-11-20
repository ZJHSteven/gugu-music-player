/**
 * iOS 隐私浏览场景：第三方 Owlbear iframe 中 OPFS 与 IndexedDB
 * 都可能不可用。传输已完成并通过 SHA-256 时，至少要允许当次会话播放；
 * 但不允许把错误摘要或未验证数据伪装为缓存文件。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { digest, getAudio, putAudio } from "../../public/cloud/storage.js";

test("OPFS + IndexedDB 同时拒绝时，已校验的音频回退到当前 iframe 内存", async () => {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const previousIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true, value: { storage: { getDirectory: async () => {
      throw new Error("PrivateBrowsingStorageDisabled");
    } } },
  });
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true, value: { open: () => {
      throw new Error("ThirdPartyIndexedDBBlocked");
    } },
  });
  try {
    const sound = new Blob([new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4])], {
      type: "audio/wav",
    });
    const hash = await digest(sound);
    assert.equal(await putAudio(hash, sound), "memory");
    const recovered = await getAudio(hash);
    assert.deepEqual(new Uint8Array(await recovered.arrayBuffer()),
      new Uint8Array(await sound.arrayBuffer()));
    await assert.rejects(putAudio("f".repeat(64), sound), /SHA-256/);
    assert.equal(await getAudio("f".repeat(64)), null);
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else delete globalThis.navigator;
    if (previousIndexedDB) Object.defineProperty(globalThis, "indexedDB", previousIndexedDB);
    else delete globalThis.indexedDB;
  }
});
