#!/usr/bin/env bash
# 一键启动（macOS / Linux）
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  没找到 Node.js。请先安装 18 或更高版本：https://nodejs.org"
  echo "  macOS 也可以用：brew install node"
  echo ""
  exit 1
fi

node scripts/setup.mjs "$@"
