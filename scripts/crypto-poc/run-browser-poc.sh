#!/usr/bin/env bash
# 构建浏览器 bundle，启动本地 HTTP 服务，用 playwright-cli 在 Chromium 中执行 PoC。
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .artifacts
./node_modules/.bin/esbuild browser-entry.mjs --bundle --platform=browser --format=iife \
  --target=chrome110 --outfile=.artifacts/browser-poc.js
python3 -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill ${SERVER_PID} 2>/dev/null || true; playwright-cli close >/dev/null 2>&1 || true' EXIT
sleep 1
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$(cd ../.. && pwd)/.cache}"
playwright-cli open http://127.0.0.1:8765/browser-test.html >/dev/null
RESULT=$(playwright-cli --raw eval "JSON.stringify({allPassed:window.__POC_RESULT__.allPassed,passedCount:window.__POC_RESULT__.results.filter(r=>r.ok).length,failed:window.__POC_RESULT__.results.filter(r=>!r.ok)})")
node -e 'let r=JSON.parse(process.argv[1]); if(typeof r==="string") r=JSON.parse(r); console.log(JSON.stringify(r)); if(!r.allPassed){process.exit(1)}' "$RESULT"
