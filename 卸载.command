#!/bin/bash
# 咕咕点歌台 · macOS 卸载
cd "$(dirname "$0")" || exit 1

echo ""
echo "  咕咕点歌台 卸载"
echo "  ================"
echo ""
echo "  这会关闭正在运行的服务，并删除程序文件。"
echo ""
printf "  确定要卸载吗？(y/N) "
read -r ANSWER
case "$ANSWER" in
  y|Y) ;;
  *) echo ""; echo "  已取消。"; exit 0 ;;
esac

echo ""
echo "  [1/3] 关闭正在运行的服务…"
# 只杀掉从本目录启动的 node / cloudflared
for PID in $(pgrep -f "$(pwd)/runtime/.*node" 2>/dev/null); do kill -9 "$PID" 2>/dev/null; done
for PID in $(pgrep -f "$(pwd)/runtime/.*cloudflared" 2>/dev/null); do kill -9 "$PID" 2>/dev/null; done
pkill -f "$(pwd)/server/index.js" 2>/dev/null

echo "  [2/3] 删除歌单与缓存…"
rm -rf "data" 2>/dev/null

echo "  [3/3] 准备删除程序文件…"
echo ""
echo "  还要手动做一步："
echo "    打开 Owlbear Rodeo，左下角三个点 → Extension，"
echo "    把「咕咕点歌台」删掉，否则那里会留一个打不开的图标。"
echo ""
printf "  按回车键删除整个文件夹… "
read -r _

cd ..
rm -rf "$(dirname "$0")"
echo "  已删除。"
