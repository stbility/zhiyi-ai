#!/usr/bin/env bash
# 新窗口/新代理开工引导 —— 先跑这个,再动手。
# 做什么:对齐 origin/main → 打印当前阶段 + 生产实况 + 本地差异。
set -euo pipefail

REPO_URL="https://github.com/stbility/zhiyi-ai.git"
LIVE_URL="${ZHIYI_LIVE_URL:-https://zhiyi-agent.theossindex.com}"

echo "== 1/4 对齐 origin/main =="
git fetch origin main:refs/remotes/origin/main --quiet 2>/dev/null || {
  echo "  当前目录不是 git 仓库或没有 origin,尝试克隆…"
  git clone --depth 50 "$REPO_URL" . 2>/dev/null || {
    echo "❌ 克隆失败。请确认在仓库目录里运行,或手动克隆 $REPO_URL"
    exit 1
  }
}
LOCAL=$(git rev-parse --short HEAD 2>/dev/null || echo "?")
MAIN=$(git rev-parse --short origin/main 2>/dev/null || echo "?")
echo "  本地 HEAD:  $LOCAL"
echo "  远端 main:  $MAIN"
if [ "$LOCAL" != "$MAIN" ]; then
  echo "  ⚠️ 本地与 main 不一致 —— 建议 git reset --hard origin/main 或基于 origin/main 重建分支"
fi

echo "== 2/4 依赖安装 =="
if [ -d node_modules ]; then
  echo "  node_modules 已存在(跳过 install;缺包报错时再跑 pnpm install --frozen-lockfile)"
else
  pnpm install --frozen-lockfile
fi

echo "== 3/4 当前开发阶段(phase.ts 真值源) =="
if [ -f src/lib/phase.ts ]; then
  grep -E "id: \"[0-9.]+\"|label:|state:" src/lib/phase.ts | head -30 \
    | sed 's/^/  /' || echo "  (phase.ts 读取失败)"
else
  echo "  (未找到 src/lib/phase.ts —— 目录不对?)"
fi

echo "== 4/4 生产实况(/status.json) =="
if command -v curl >/dev/null 2>&1; then
  LIVE=$(curl -s --max-time 8 "$LIVE_URL/status.json" || echo '{"error":"unreachable"}')
  echo "$LIVE" | head -c 800 | sed 's/^/  /'
  echo ""
  DEPLOYED=$(echo "$LIVE" | grep -o '"deployed_sha":"[^"]*"' | cut -d'"' -f4)
  if [ -n "$DEPLOYED" ] && [ "$DEPLOYED" != "$MAIN" ]; then
    echo "  ⚠️ 生产部署 SHA($DEPLOYED)≠ 仓库 main($MAIN)—— 部署滞后或未部署,交付未完成"
  else
    echo "  ✅ 生产部署 SHA 与仓库 main 一致(或 /status.json 尚未上线,属预期过渡态)"
  fi
else
  echo "  (无 curl,跳过生产探测)"
fi

echo ""
echo "开工前请读仓库根 AGENTS.md(状态真值源/工作区纪律/交付判定)。"
