// 平台判断的断言测试：没有 Mac 也能验证「Mac 上会选哪个目录」。
import assert from "node:assert";
import { runtimeDir, cloudflaredName, nodeBinaryName, cloudflaredUrl } from "../scripts/platform.mjs";

let pass = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log("  ✓ " + name);
  } catch (err) {
    console.log("  ✗ " + name + " → " + err.message);
    process.exitCode = 1;
  }
};

t("Windows 用 runtime 根目录", () => {
  assert.equal(runtimeDir("win32", "x64"), "runtime");
});
t("Mac arm64 用 darwin-arm64", () => {
  assert.equal(runtimeDir("darwin", "arm64"), "runtime/darwin-arm64");
});
t("Mac x64 用 darwin-x64", () => {
  assert.equal(runtimeDir("darwin", "x64"), "runtime/darwin-x64");
});
t("Linux 也用 runtime 根目录", () => {
  assert.equal(runtimeDir("linux", "x64"), "runtime");
});
t("Windows 的 cloudflared 带 .exe", () => {
  assert.equal(cloudflaredName("win32"), "cloudflared.exe");
});
t("macOS 的 cloudflared 不带后缀", () => {
  assert.equal(cloudflaredName("darwin"), "cloudflared");
});
t("Windows 的 node 带 .exe", () => {
  assert.equal(nodeBinaryName("win32"), "node.exe");
});
t("macOS 的 node 不带后缀", () => {
  assert.equal(nodeBinaryName("darwin"), "node");
});
t("Mac arm64 下载 arm64 版 cloudflared", () => {
  const a = cloudflaredUrl("darwin", "arm64");
  assert.ok(a.url.includes("darwin-arm64"), a.url);
  assert.equal(a.tgz, true);
});
t("Mac x64 下载 amd64 版 cloudflared", () => {
  const a = cloudflaredUrl("darwin", "x64");
  assert.ok(a.url.includes("darwin-amd64"), a.url);
  assert.equal(a.tgz, true);
});
t("Windows 下载 exe 而不是 tgz", () => {
  const a = cloudflaredUrl("win32", "x64");
  assert.ok(a.url.endsWith(".exe"), a.url);
  assert.equal(a.tgz, false);
});
t("Linux 下载二进制", () => {
  const a = cloudflaredUrl("linux", "x64");
  assert.ok(a.url.includes("linux-amd64"), a.url);
  assert.equal(a.tgz, false);
});

console.log(`\n结果：${pass} 通过`);
