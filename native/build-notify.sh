#!/bin/bash
set -euo pipefail

# Build SisyphusNotify.app — macOS notification helper with click-to-switch
# Requires: Xcode Command Line Tools (swiftc)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/SisyphusNotify"
APP_NAME="SisyphusNotify"
INSTALL_DIR="$HOME/.sisyphus"

# Paths
APP_BUNDLE="$INSTALL_DIR/$APP_NAME.app"
CONTENTS="$APP_BUNDLE/Contents"
MACOS_DIR="$CONTENTS/MacOS"
BINARY="$MACOS_DIR/sisyphus-notify"

print_first_install_banner() {
  if [ ! -f "$HOME/Library/LaunchAgents/com.sisyphus.daemon.plist" ]; then
    cat <<'EOF'

════════════════════════════════════════════════════════════
sisyphus installed — daemon not yet running.

Next: `sis admin setup` installs the launchd daemon,
tmux keybinds, and the sisyphus@sisyphus Claude plugin.

After setup, `sis admin getting-started` runs an
interactive tutorial (best inside Claude Code — emits
<claude-instructions> blocks designed for Claude to follow).
════════════════════════════════════════════════════════════

EOF
  fi
}

# Check for swiftc
if ! command -v swiftc &>/dev/null; then
  echo "Error: swiftc not found. Install Xcode Command Line Tools: xcode-select --install" >&2
  print_first_install_banner
  exit 1
fi

# Only rebuild if source is newer than binary
if [ -f "$BINARY" ] && [ "$SRC_DIR/main.swift" -ot "$BINARY" ] && [ "$SRC_DIR/Info.plist" -ot "$BINARY" ]; then
  echo "SisyphusNotify.app is up to date"
  print_first_install_banner
  exit 0
fi

echo "Building $APP_NAME.app..."

# Create bundle structure
mkdir -p "$MACOS_DIR"

# Compile
swiftc \
  -O \
  -o "$BINARY" \
  -framework Cocoa \
  -framework UserNotifications \
  "$SRC_DIR/main.swift"

# Copy Info.plist
cp "$SRC_DIR/Info.plist" "$CONTENTS/Info.plist"

# Copy icon if available
RESOURCES_DIR="$CONTENTS/Resources"
if [ -f "$SRC_DIR/AppIcon.icns" ]; then
  mkdir -p "$RESOURCES_DIR"
  cp "$SRC_DIR/AppIcon.icns" "$RESOURCES_DIR/AppIcon.icns"
  # Create PNG for notification attachment
  sips -s format png "$SRC_DIR/AppIcon.icns" --out "$RESOURCES_DIR/icon.png" --resampleWidth 256 >/dev/null 2>&1
fi

# Ad-hoc sign
codesign -s - --force "$APP_BUNDLE"

echo "Built: $APP_BUNDLE"

print_first_install_banner
