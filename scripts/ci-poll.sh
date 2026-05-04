#!/usr/bin/env bash
# ============================================================================
# CI Poll Runner — 自动拉取 + 测试 (无需 GitHub Actions runner 权限)
# ----------------------------------------------------------------------------
# 定时从 GitHub pull 最新代码，发现新 commit 后自动运行 E2E 测试。
# 设为 cron/launchd 任务，即可实现 push-to-test 的效果。
#
# Usage:
#   bash scripts/ci-poll.sh                 # 单次执行
#   bash scripts/ci-poll.sh --loop 300      # 每 5 分钟轮询一次
#   bash scripts/ci-poll.sh --branch main   # 指定分支
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

BRANCH="${CI_BRANCH:-release}"
LOOP_INTERVAL=0
MODE="${CI_MODE:-smoke}"
REPORT_DIR="${REPO_ROOT}/.ci-reports"

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --loop)    LOOP_INTERVAL="$2"; shift 2 ;;
    --branch)  BRANCH="$2"; shift 2 ;;
    --mode)    MODE="$2"; shift 2 ;;
    *)         shift ;;
  esac
done

mkdir -p "$REPORT_DIR"
LAST_SHA_FILE="${REPORT_DIR}/.last-tested-sha"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

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

  # Check if ui/node_modules needs refresh
  if [[ "ui/package-lock.json" -nt "ui/node_modules/.package-lock.json" ]] 2>/dev/null; then
    log "package-lock.json changed, running npm install..."
    cd "$REPO_ROOT/ui" && npm install --prefer-offline --silent 2>/dev/null
    cd "$REPO_ROOT"
  fi

  # Run test
  local TIMESTAMP
  TIMESTAMP=$(date '+%Y%m%d-%H%M%S')
  local REPORT_FILE="${REPORT_DIR}/report-${TIMESTAMP}.txt"

  log "Running E2E test (${MODE})..."
  log "Report: ${REPORT_FILE}"

  local EXIT_CODE=0
  bash "${SCRIPT_DIR}/ci-e2e.sh" "$MODE" 2>&1 | tee "$REPORT_FILE" || EXIT_CODE=$?

  # Save result summary
  local STATUS="PASS"
  [[ $EXIT_CODE -ne 0 ]] && STATUS="FAIL"

  cat >> "${REPORT_DIR}/history.log" <<EOF
${TIMESTAMP} | ${STATUS} | ${REMOTE_SHA:0:8} | ${COMMIT_MSG:0:60} | exit=${EXIT_CODE}
EOF

  # Record tested SHA
  echo "$REMOTE_SHA" > "$LAST_SHA_FILE"

  if [[ $EXIT_CODE -eq 0 ]]; then
    log "✅ Test PASSED for ${REMOTE_SHA:0:8}"
  else
    log "❌ Test FAILED for ${REMOTE_SHA:0:8} (exit: ${EXIT_CODE})"
  fi

  return $EXIT_CODE
}

# ── Main ──
if [[ "$LOOP_INTERVAL" -gt 0 ]]; then
  log "Starting poll loop (branch=${BRANCH}, interval=${LOOP_INTERVAL}s, mode=${MODE})"
  while true; do
    run_once || true
    log "Sleeping ${LOOP_INTERVAL}s..."
    sleep "$LOOP_INTERVAL"
  done
else
  run_once
fi
