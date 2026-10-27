#!/bin/zsh
# 按需启动本机选品设置面板（端口 56115，仅本机访问）。不会自动开始选品。
cd -- "$(dirname "$0")" || exit 1
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "未找到 node，请先安装 Node.js 22.5 或更高版本。"
  read -r "?按回车退出"
  exit 1
fi
exec "$NODE_BIN" src/cli.mjs settings --core-only --no-open --port 56115
