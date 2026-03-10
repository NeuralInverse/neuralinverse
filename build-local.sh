#!/usr/bin/env bash
################################################################################
#  NeuralInverse IDE — Local Build Script
#
#  Mirrors exactly what the Azure Pipeline does for macOS arm64.
#  Run this locally to verify the build before pushing.
#
#  Usage:
#    chmod +x build-local.sh
#    GITHUB_TOKEN=your_token ./build-local.sh
#
#  Or set GITHUB_TOKEN in your shell first:
#    export GITHUB_TOKEN=ghp_xxxxxxxxxxxx
#    ./build-local.sh
#
#  Output: .build/release/
#    NeuralInverse-0.1.0-darwin-arm64.dmg
#    NeuralInverse-0.1.0-darwin-arm64.zip
#    NeuralInverse-0.1.0-darwin-arm64.pkg
################################################################################

set -e

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

step()  { echo -e "\n${BLUE}▶ $1${NC}"; }
ok()    { echo -e "${GREEN}✓ $1${NC}"; }
warn()  { echo -e "${YELLOW}⚠ $1${NC}"; }
fail()  { echo -e "${RED}✗ $1${NC}"; exit 1; }

# ── Config ────────────────────────────────────────────────────────────────────
VERSION="0.1.0"
DISPLAY_NAME="NeuralInverse"
BUNDLE_ID="com.neuralinverse.code"
QUALITY="stable"
RELEASE_DIR=".build/release"

# ── Checks ────────────────────────────────────────────────────────────────────
step "Pre-flight checks"

if [ -z "$GITHUB_TOKEN" ]; then
  warn "GITHUB_TOKEN is not set — @vscode/ripgrep download may hit GitHub rate limit (403)"
  warn "Set it with: export GITHUB_TOKEN=ghp_xxxxxxxxxxxx"
  echo ""
fi

if ! command -v node &>/dev/null; then
  fail "Node.js not found. Install from https://nodejs.org (v20.x recommended)"
fi

NODE_VER=$(node -v)
ok "Node.js $NODE_VER"

if ! command -v npm &>/dev/null; then
  fail "npm not found"
fi

ok "npm $(npm -v)"

# ── npm ci ────────────────────────────────────────────────────────────────────
step "Install dependencies (npm ci)"

npm config set fetch-retry-mintimeout 20000
npm config set fetch-retry-maxtimeout 120000
npm config set fetch-retries 5
npm config set fetch-timeout 300000

npm_config_arch=arm64 \
ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
GITHUB_TOKEN="${GITHUB_TOKEN}" \
npm ci

ok "Dependencies installed"

# ── Build React UI ────────────────────────────────────────────────────────────
step "Build React UI"
npm run buildreact
ok "React UI built"

# ── Compile TypeScript ────────────────────────────────────────────────────────
step "Compile TypeScript (compile-build)"
NODE_OPTIONS="--max-old-space-size=6144" \
node node_modules/.bin/gulp compile-build-without-mangling
ok "TypeScript compiled"

# ── Minify ────────────────────────────────────────────────────────────────────
step "Minify — produces out-vscode-min/"
NODE_OPTIONS="--max-old-space-size=6144" \
node node_modules/.bin/gulp minify-vscode
ok "Minification done"

# ── Package macOS arm64 ───────────────────────────────────────────────────────
step "Package macOS arm64"
VSCODE_QUALITY="$QUALITY" \
npm_config_arch=arm64 \
node node_modules/.bin/gulp vscode-darwin-arm64-min-ci
ok "Packaging done"

# ── Collect .dmg and .zip ────────────────────────────────────────────────────
step "Collect .dmg and .zip"
mkdir -p "$RELEASE_DIR"

while IFS= read -r f; do
  [ -f "$f" ] || continue
  EXT="${f##*.}"
  DEST="$RELEASE_DIR/${DISPLAY_NAME}-${VERSION}-darwin-arm64.${EXT}"
  cp "$f" "$DEST"
  ok "Collected: $DEST"
done < <(find . \( -name "*.dmg" -o -name "*.zip" \) \
            -not -path "*/node_modules/*" \
            -not -path "*/.git/*" \
            -not -path "*/.build/release/*" \
            2>/dev/null)

# ── Build .pkg ────────────────────────────────────────────────────────────────
step "Build .pkg (enterprise / MDM)"

PKG_OUT="$RELEASE_DIR/${DISPLAY_NAME}-${VERSION}-darwin-arm64.pkg"

APP_BUNDLE=$(find . .. \
  -maxdepth 4 \
  -name "${DISPLAY_NAME}.app" \
  -type d \
  -not -path "*/node_modules/*" \
  2>/dev/null | head -1)

if [ -z "$APP_BUNDLE" ]; then
  ZIP=$(find "$RELEASE_DIR" -name "*.zip" | head -1)
  if [ -n "$ZIP" ]; then
    TMPDIR_EXTRACT=$(mktemp -d)
    unzip -q "$ZIP" -d "$TMPDIR_EXTRACT"
    APP_BUNDLE=$(find "$TMPDIR_EXTRACT" -maxdepth 3 -name "*.app" -type d | head -1)
  fi
fi

if [ -n "$APP_BUNDLE" ]; then
  pkgbuild \
    --component "$APP_BUNDLE" \
    --identifier "$BUNDLE_ID" \
    --version "$VERSION" \
    --install-location "/Applications" \
    "$PKG_OUT"
  ok "Produced: $PKG_OUT"
else
  warn ".app bundle not found — .pkg skipped"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Build complete — artifacts in $RELEASE_DIR/${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
ls -lh "$RELEASE_DIR/" 2>/dev/null || warn "No artifacts found in $RELEASE_DIR"
