#!/bin/sh
# macOS / Linux 启动脚本；Windows 用户双击「启动.bat」
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js，请先安装 https://nodejs.org （建议 20 以上）"
  exit 1
fi
exec node server.js
