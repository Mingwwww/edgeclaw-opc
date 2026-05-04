#!/usr/bin/env bash
# ============================================================================
# CI Poll Runner — 自动拉取 + 测试 + 飞书通知
# ----------------------------------------------------------------------------
# 定时从 GitHub pull 最新代码，发现新 commit 后自动运行 E2E 测试。
# 测试失败或通过都会通过飞书 webhook 发送通知。
#
# Usage:
#   bash scripts/ci-poll.sh                       # 单次执行
#   bash scripts/ci-poll.sh --loop 28800          # 每 8 小时轮询
#   bash scripts/ci-poll.sh --branch release      # 指定分支
#   bash scripts/ci-poll.sh --webhook URL         # 飞书 webhook URL
#
# 环境变量:
#   CI_FEISHU_WEBHOOK  — 飞书机器人 webhook URL (优先级低于 --webhook)
#   CI_BRANCH          — 监控的分支 (default: release)
#   CI_MODE            — 测试模式 smoke/full/auto (default: smoke)
#
# 飞书 webhook 设置方法:
#   1. 飞书群 → 设置 → 群机器人 → 添加机器人 → 自定义机器人
#   2. 复制 webhook 地址 (格式: https://open.feishu.cn/open-apis/bot/v2/hook/xxx)
#   3. 设置为 CI_FEISHU_WEBHOOK 环境变量或 --webhook 参数
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

BRANCH="${CI_BRANCH:-release}"
LOOP_INTERVAL=0
MODE="${CI_MODE:-smoke}"
REPORT_DIR="${REPO_ROOT}/.ci-reports"
FEISHU_WEBHOOK="${CI_FEISHU_WEBHOOK:-}"

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --loop)    LOOP_INTERVAL="$2"; shift 2 ;;
    --branch)  BRANCH="$2"; shift 2 ;;
    --mode)    MODE="$2"; shift 2 ;;
    --webhook) FEISHU_WEBHOOK="$2"; shift 2 ;;
    *)         shift ;;
  esac
done

mkdir -p "$REPORT_DIR"
LAST_SHA_FILE="${REPORT_DIR}/.last-tested-sha-${BRANCH}"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# ── 飞书通知 ──
notify_feishu() {
  local status="$1" sha="$2" commit_msg="$3" elapsed="$4" detail="${5:-}"

  [[ -z "$FEISHU_WEBHOOK" ]] && return 0

  local color="green"
  local emoji="✅"
  [[ "$status" == "FAIL" ]] && color="red" && emoji="❌"

  local content="${emoji} **EdgeClaw CI ${status}**\n"
  content+="分支: \`${BRANCH}\`  提交: \`${sha}\`\n"
  content+="消息: ${commit_msg}\n"
  content+="耗时: ${elapsed}s  模式: ${MODE}\n"
  [[ -n "$detail" ]] && content+="\n${detail}"

  curl -s -X POST "$FEISHU_WEBHOOK" \
    -H "Content-Type: application/json" \
    -d "{
      \"msg_type\": \"interactive\",
      \"card\": {
        \"header\": {
          \"title\": { \"tag\": \"plain_text\", \"content\": \"CI ${status}: ${sha}\" },
          \"template\": \"${color}\"
        },
        \"elements\": [{
          \"tag\": \"markdown\",
          \"content\": \"${content}\"
        }]
      }
    }" > /dev/null 2>&1 || log "⚠ Feishu notification failed"
}

run_once() {
  cd "$REPO_ROOT"

  # Pull latest
  git fetch origin "$BRANCH" --quiet 2>/dev/null
  local REMOTE_SHA
  REMOTE_SHA=$(git rev-parse "origin/${BRANCH}")
  local LAST_SHA
  LAST_SHA=$(cat "$LAST_SHA_FILE" 2>/dev/null || echo "none")

  if [[ "$REMOTE_SHA" == "$LAST_SHA" ]]; then
    log "No new commits on ${BRANCH} (${REMOTE_SHA:0:8})"
    return 0
  fi

  log "New commit detected: ${LAST_SHA:0:8} → ${REMOTE_SHA:0:8}"
  log "Checking out ${BRANCH}..."

  git checkout "$BRANCH" --quiet 2>/dev/null
  git pull origin "$BRANCH" --quiet 2>/dev/null

  local COMMIT_MSG
  COMMIT_MSG=$(git log -1 --format='%s' HEAD)
  log "HEAD: ${REMOTE_SHA:0:8} — ${COMMIT_MSG}"

  # Check if deps need refresh
  if [[ "ui/package-lock.json" -nt "ui/node_modules/.package-lock.json" ]] 2>/dev/null; then
    log "package-lock.json changed, running npm install..."
    cd "$REPO_ROOT/ui" && npm install --prefer-offline --silent 2>/dev/null
    cd "$REPO_ROOT"
  fi

  # Run test
  local TIMESTAMP
  TIMESTAMP=$(date '+%Y%m%d-%H%M%S')
  local REPORT_FILE="${REPORT_DIR}/report-${TIMESTAMP}.txt"
  local START_TS=$SECONDS

  log "Running E2E test (${MODE})..."
  log "Report: ${REPORT_FILE}"

  local EXIT_CODE=0
  bash "${SCRIPT_DIR}/ci-e2e.sh" "$MODE" 2>&1 | tee "$REPORT_FILE" || EXIT_CODE=$?

  local ELAPSED=$(( SECONDS - START_TS ))

  # Save result summary
  local STATUS="PASS"
  [[ $EXIT_CODE -ne 0 ]] && STATUS="FAIL"

  cat >> "${REPORT_DIR}/history.log" <<EOF
${TIMESTAMP} | ${STATUS} | ${REMOTE_SHA:0:8} | ${COMMIT_MSG:0:60} | exit=${EXIT_CODE} | ${ELAPSED}s
EOF

  # Record tested SHA
  echo "$REMOTE_SHA" > "$LAST_SHA_FILE"

  # Notify
  local DETAIL=""
  if [[ $EXIT_CODE -ne 0 ]]; then
    DETAIL=$(grep -E "^  [✅❌⏱️]" "$REPORT_FILE" 2>/dev/null | head -15 || true)
  fi
  notify_feishu "$STATUS" "${REMOTE_SHA:0:8}" "$COMMIT_MSG" "$ELAPSED" "$DETAIL"

  if [[ $EXIT_CODE -eq 0 ]]; then
    log "✅ Test PASSED for ${REMOTE_SHA:0:8} (${ELAPSED}s)"
  else
    log "❌ Test FAILED for ${REMOTE_SHA:0:8} (exit: ${EXIT_CODE}, ${ELAPSED}s)"
  fi

  return $EXIT_CODE
}

# ── Main ──
if [[ "$LOOP_INTERVAL" -gt 0 ]]; then
  log "Starting poll loop (branch=${BRANCH}, interval=${LOOP_INTERVAL}s, mode=${MODE})"
  [[ -n "$FEISHU_WEBHOOK" ]] && log "Feishu notifications: ON" || log "Feishu notifications: OFF"
  while true; do
    run_once || true
    log "Sleeping ${LOOP_INTERVAL}s ($(( LOOP_INTERVAL / 3600 ))h)..."
    sleep "$LOOP_INTERVAL"
  done
else
  run_once
fi
