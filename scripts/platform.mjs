// 平台判断集中在这里：既是 setup.mjs 的唯一来源，也方便在没有 Mac 的机器上做断言测试。
// 之所以单独抽出来，是因为"Mac 上该用哪个目录"这种事只能在开发机上验证逻辑，
// 真机验证成本太高。

/** 运行时目录（相对项目根）。Windows 在 runtime/ 根，macOS 在 runtime/darwin-<arch>/。 */
export function runtimeDir(platform, arch) {
  if (platform === "darwin") return arch === "arm64" ? "runtime/darwin-arm64" : "runtime/darwin-x64";
  return "runtime";
}

export function cloudflaredName(platform) {
  return platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

export function nodeBinaryName(platform) {
  return platform === "win32" ? "node.exe" : "node";
}

/** cloudflared 的下载地址：三个平台各自不同，macOS 还要区分芯片。 */
export function cloudflaredUrl(platform, arch) {
  const arm = arch === "arm64";
  if (platform === "win32") {
    return {
      url: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe",
      tgz: false,
    };
  }
  if (platform === "darwin") {
    return {
      url: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${arm ? "arm64" : "amd64"}.tgz`,
      tgz: true,
    };
  }
  return {
    url: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64",
    tgz: false,
  };
}
