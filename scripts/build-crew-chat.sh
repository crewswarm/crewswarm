#!/usr/bin/env bash
# Compile CrewChat.swift and deploy to ~/Applications/crewchat.app
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/Applications/crewchat.app"

echo "→ Compiling CrewChat.swift..."
swiftc -framework AppKit -framework Foundation \
  -o "$HOME/bin/crew-chat-app" \
  "$SCRIPT_DIR/apps/crewchat/CrewChat.swift"

echo "→ Deploying to $APP..."
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$HOME/bin/crew-chat-app" "$APP/Contents/MacOS/crewchat"
chmod +x "$APP/Contents/MacOS/crewchat"

# Rebuild icon from favicon
ICONSET="/tmp/crewchat.iconset"
mkdir -p "$ICONSET"
for SIZE in 16 32 64 128 256 512; do
  sips -z $SIZE $SIZE "$SCRIPT_DIR/website/favicon.png" --out "$ICONSET/icon_${SIZE}x${SIZE}.png" 2>/dev/null
  sips -z $((SIZE*2)) $((SIZE*2)) "$SCRIPT_DIR/website/favicon.png" --out "$ICONSET/icon_${SIZE}x${SIZE}@2x.png" 2>/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/crewchat.icns"
touch "$APP"

echo "✅ Done. Run: open ~/Applications/crewchat.app"
