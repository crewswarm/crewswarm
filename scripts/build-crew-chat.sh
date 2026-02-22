#!/usr/bin/env bash
# Compile CrewChat.swift and deploy to ~/Applications/CrewChat.app
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/Applications/CrewChat.app"

echo "→ Compiling CrewChat.swift..."
swiftc -framework AppKit -framework Foundation \
  -o "$HOME/bin/crew-chat-app" \
  "$SCRIPT_DIR/CrewChat.swift"

echo "→ Deploying to $APP..."
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$HOME/bin/crew-chat-app" "$APP/Contents/MacOS/CrewChat"
chmod +x "$APP/Contents/MacOS/CrewChat"

# Rebuild icon from favicon
ICONSET="/tmp/CrewChat.iconset"
mkdir -p "$ICONSET"
for SIZE in 16 32 64 128 256 512; do
  sips -z $SIZE $SIZE "$SCRIPT_DIR/website/favicon.png" --out "$ICONSET/icon_${SIZE}x${SIZE}.png" 2>/dev/null
  sips -z $((SIZE*2)) $((SIZE*2)) "$SCRIPT_DIR/website/favicon.png" --out "$ICONSET/icon_${SIZE}x${SIZE}@2x.png" 2>/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/CrewChat.icns"
touch "$APP"

echo "✅ Done. Run: open ~/Applications/CrewChat.app"
