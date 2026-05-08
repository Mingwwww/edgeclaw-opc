#!/usr/bin/env bash
set -euo pipefail

# Politdeck one-line installer for macOS
# Usage: curl -fsSL https://raw.githubusercontent.com/siteboon/claudecodeui/feat/onboarding-llm-setup/install.sh | bash
#
# Installs to: ~/.edgeclaw/app/
# Data dir:    ~/.edgeclaw/
# Config:      ~/.edgeclaw/config.yaml
# CLI symlink: /usr/local/bin/politdeck

REPO_URL="https://github.com/siteboon/claudecodeui.git"
INSTALL_DIR="$HOME/.edgeclaw/app"
BIN_LINK="/usr/local/bin/politdeck"
BRANCH="feat/onboarding-llm-setup"

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
echo -e "${BOLD}Politdeck Installer${RESET}"
echo "===================="
echo ""

# -------------------------------------------------------------------
# 1. Check macOS
# -------------------------------------------------------------------
echo "Checking system requirements..."
if [[ "$(uname -s)" != "Darwin" ]]; then
  fail "This installer currently supports macOS only."
fi
ok "macOS detected"
echo ""

# -------------------------------------------------------------------
# 2. Check / install Node.js (>= 18)
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
# 3. Check git
# -------------------------------------------------------------------
echo "Checking git..."
if ! command -v git &>/dev/null; then
  fail "git is not installed. Please install Xcode Command Line Tools: xcode-select --install"
fi
ok "git found"
echo ""

# -------------------------------------------------------------------
# 4. Clone or update the repository
# -------------------------------------------------------------------
echo "Installing politdeck to ${DIM}${INSTALL_DIR}${RESET} ..."
mkdir -p "$(dirname "$INSTALL_DIR")"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  warn "Existing installation found. Updating..."
  cd "$INSTALL_DIR"
  git fetch origin "$BRANCH" --quiet
  git checkout "$BRANCH" --quiet 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH" --quiet
  git pull origin "$BRANCH" --quiet
  ok "Updated to latest"
else
  if [[ -d "$INSTALL_DIR" ]]; then
    warn "Cleaning incomplete installation at $INSTALL_DIR"
    rm -rf "$INSTALL_DIR"
  fi
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR" --quiet
  ok "Repository cloned"
fi
echo ""

# -------------------------------------------------------------------
# 5. Install npm dependencies
# -------------------------------------------------------------------
echo "Installing dependencies..."
cd "$INSTALL_DIR/ui"
npm install --omit=dev --no-audit --no-fund --loglevel=error 2>&1 | tail -1 || true
ok "Dependencies installed"
echo ""

# -------------------------------------------------------------------
# 6. Create CLI symlink
# -------------------------------------------------------------------
echo "Setting up CLI command..."
CLI_TARGET="$INSTALL_DIR/ui/server/cli.js"

if [[ -L "$BIN_LINK" ]]; then
  rm "$BIN_LINK"
fi

if [[ -w "$(dirname "$BIN_LINK")" ]]; then
  ln -sf "$CLI_TARGET" "$BIN_LINK"
  ok "politdeck command linked to ${DIM}${BIN_LINK}${RESET}"
else
  warn "Need permission to create ${BIN_LINK}"
  sudo ln -sf "$CLI_TARGET" "$BIN_LINK"
  ok "politdeck command linked to ${DIM}${BIN_LINK}${RESET}"
fi
echo ""

# -------------------------------------------------------------------
# 7. Summary
# -------------------------------------------------------------------
echo -e "${BOLD}Installation complete!${RESET}"
echo ""
echo -e "  App location:   ${DIM}${INSTALL_DIR}${RESET}"
echo -e "  Config file:    ${DIM}~/.edgeclaw/config.yaml${RESET}"
echo -e "  CLI command:    ${DIM}politdeck${RESET}"
echo ""

# -------------------------------------------------------------------
# 8. Start
# -------------------------------------------------------------------
echo "Starting politdeck..."
echo ""
exec node "$CLI_TARGET"
