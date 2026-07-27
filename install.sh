#!/usr/bin/env bash
# Adds "Claude Code Studio" to the Ubuntu application menu.
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPS="$HOME/.local/share/applications"
DESKTOP="$APPS/claude-code-studio.desktop"

chmod +x "$DIR/run.sh"
mkdir -p "$APPS"

cat > "$DESKTOP" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=Claude Code Studio
Comment=Desktop GUI for Claude Code
Exec=$DIR/run.sh
Icon=$DIR/build/icon.png
Terminal=false
Categories=Development;Utility;
StartupWMClass=Claude Code Studio
EOF

chmod +x "$DESKTOP"
update-desktop-database "$APPS" 2>/dev/null || true

echo "Installed. Search for 'Claude Code Studio' in your Activities / app grid."
echo "Desktop entry: $DESKTOP"
