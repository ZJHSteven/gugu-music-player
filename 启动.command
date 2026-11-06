#!/bin/bash
# 咕咕点歌台 · macOS 启动脚本
# 双击即可运行。第一次运行可能会被系统拦一次，见同目录的「macOS 首次运行说明.txt」。

cd "$(dirname "$0")" || exit 1

echo ""
echo "  咕咕点歌台 正在启动…"
echo ""

# 判断芯片：Apple Silicon 用 darwin-arm64，Intel 用 darwin-x64
ARCHDIR=""
if [ "$(uname -s)" = "Darwin" ]; then
  if [ "$(uname -m)" = "arm64" ]; then
    ARCHDIR="darwin-arm64"
  else
    ARCHDIR="darwin-x64"
  fi
fi

NODE_BIN=""
if [ -n "$ARCHDIR" ] && [ -f "runtime/$ARCHDIR/node" ]; then
  # 从 zip 解压后执行权限会丢，这里补上；顺便去掉“下载来的文件”隔离标记
  chmod +x "runtime/$ARCHDIR/node" 2>/dev/null
  chmod +x "runtime/$ARCHDIR/cloudflared" 2>/dev/null
  xattr -dr com.apple.quarantine "runtime/$ARCHDIR" 2>/dev/null
  NODE_BIN="runtime/$ARCHDIR/node"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
fi

if [ -z "$NODE_BIN" ]; then
  echo "  没找到可用的 Node.js。"
  echo "  正常情况下包里自带，如果没有，请到 https://nodejs.org 装一个 18 以上版本。"
  echo ""
  read -n 1 -s -r -p "  按任意键关闭…"
  exit 1
fi

"$NODE_BIN" scripts/setup.mjs "$@"
STATUS=$?

echo ""
if [ $STATUS -ne 0 ]; then
  echo "  启动失败（退出码 $STATUS），把上面的提示截图发给作者。"
else
  echo "  程序已停止。"
fi
echo ""
read -n 1 -s -r -p "  按任意键关闭这个窗口…"
