#!/usr/bin/env bash
set -euo pipefail

# Politdeck one-line installer for macOS
# Usage: curl -fsSL https://raw.githubusercontent.com/siteboon/claudecodeui/main/install.sh | bash

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

ok()   { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
warn() { printf "  ${YELLOW}→${RESET} %s\n" "$1"; }
fail() { printf "  ${RED}✗${RESET} %s\n" "$1"; exit 1; }

echo ""
echo "${BOLD}Politdeck Installer${RESET}"
echo "===================="
echo ""

# -------------------------------------------------------------------
# Check macOS
# -------------------------------------------------------------------
echo "Checking system requirements..."
if [[ "$(uname -s)" != "Darwin" ]]; then
  fail "This installer currently supports macOS only."
fi
ok "macOS detected"
echo ""

# -------------------------------------------------------------------
# Check / install Node.js
# -------------------------------------------------------------------
echo "Checking Node.js..."
if command -v node &>/dev/null; then
  NODE_VERSION=$(node --version)
  NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)
  if [[ "$NODE_MAJOR" -ge 18 ]]; then
    ok "Node.js ${NODE_VERSION} found"
  else
    warn "Node.js ${NODE_VERSION} is too old (need >=18). Upgrading..."
    if command -v fnm &>/dev/null; then
      fnm install 22 && fnm use 22
    elif command -v nvm &>/dev/null; then
      nvm install 22 && nvm use 22
    else
      warn "Installing fnm (Fast Node Manager)..."
      curl -fsSL https://fnm.vercel.app/install | bash
      export PATH="$HOME/.local/share/fnm:$PATH"
      eval "$(fnm env)"
      fnm install 22 && fnm use 22
    fi
    ok "Node.js $(node --version) installed"
  fi
else
  warn "Node.js not found. Installing via fnm..."
  curl -fsSL https://fnm.vercel.app/install | bash
  export PATH="$HOME/.local/share/fnm:$PATH"
  eval "$(fnm env)"
  fnm install 22 && fnm use 22
  ok "Node.js $(node --version) installed"
fi
echo ""

# -------------------------------------------------------------------
# Install or update politdeck
# -------------------------------------------------------------------
echo "Installing politdeck..."
if command -v politdeck &>/dev/null; then
  CURRENT=$(politdeck version 2>/dev/null || echo "unknown")
  warn "politdeck ${CURRENT} already installed. Updating..."
  npm update -g politdeck 2>/dev/null || npm update -g @cloudcli-ai/cloudcli 2>/dev/null || true
else
  warn "npm install -g politdeck"
  npm install -g politdeck 2>/dev/null || npm install -g @cloudcli-ai/cloudcli
fi
ok "politdeck $(politdeck version 2>/dev/null || echo '') installed"
echo ""

# -------------------------------------------------------------------
# Start
# -------------------------------------------------------------------
echo "Starting politdeck..."
echo ""
exec politdeck
