#!/bin/bash
# crewchat.app Build Script
# Compiles CrewChat.swift into a standalone macOS app

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$SCRIPT_DIR"

APP_NAME="crewchat"
APP_DIR="/Applications/$APP_NAME.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

echo "🔨 Building crewchat.app..."

# Kill running instance if exists
pkill -x "$APP_NAME" 2>/dev/null || true
sleep 1

# Remove old version
rm -rf "$APP_DIR"

# Create app bundle structure
mkdir -p "$MACOS_DIR"
mkdir -p "$RESOURCES_DIR"

# Compile Swift source
echo "📦 Compiling Swift..."
swiftc -o "$MACOS_DIR/$APP_NAME" \
       CrewChat.swift \
       -framework AppKit \
       -framework Foundation \
       -framework AVFoundation \
       -O

# Create app icon from stinki-logo.png (higher resolution)
FAVICON="$REPO_DIR/website/stinki-logo.png"
if [ -f "$FAVICON" ]; then
    echo "🎨 Creating app icon using stinki-logo.png..."
    mkdir -p /tmp/AppIcon.iconset
    sips -z 16 16     "$FAVICON" --out /tmp/AppIcon.iconset/icon_16x16.png >/dev/null 2>&1
    sips -z 32 32     "$FAVICON" --out /tmp/AppIcon.iconset/icon_16x16@2x.png >/dev/null 2>&1
    sips -z 32 32     "$FAVICON" --out /tmp/AppIcon.iconset/icon_32x32.png >/dev/null 2>&1
    sips -z 64 64     "$FAVICON" --out /tmp/AppIcon.iconset/icon_32x32@2x.png >/dev/null 2>&1
    sips -z 128 128   "$FAVICON" --out /tmp/AppIcon.iconset/icon_128x128.png >/dev/null 2>&1
    sips -z 256 256   "$FAVICON" --out /tmp/AppIcon.iconset/icon_128x128@2x.png >/dev/null 2>&1
    sips -z 256 256   "$FAVICON" --out /tmp/AppIcon.iconset/icon_256x256.png >/dev/null 2>&1
    sips -z 512 512   "$FAVICON" --out /tmp/AppIcon.iconset/icon_256x256@2x.png >/dev/null 2>&1
    sips -z 512 512   "$FAVICON" --out /tmp/AppIcon.iconset/icon_512x512.png >/dev/null 2>&1
    sips -z 1024 1024 "$FAVICON" --out /tmp/AppIcon.iconset/icon_512x512@2x.png >/dev/null 2>&1
    iconutil -c icns /tmp/AppIcon.iconset -o "$RESOURCES_DIR/AppIcon.icns" || echo "⚠️ iconutil failed — using default icon"
    rm -rf /tmp/AppIcon.iconset
else
    echo "⚠️ No favicon.png found at $FAVICON — app will use default icon"
fi

# Create Info.plist
echo "📝 Creating Info.plist..."
cat > "$CONTENTS_DIR/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>crewchat</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundleIdentifier</key>
    <string>com.crewswarm.crewchat</string>
    <key>CFBundleName</key>
    <string>crewchat</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>2.0</string>
    <key>CFBundleVersion</key>
    <string>2</string>
    <key>LSMinimumSystemVersion</key>
    <string>10.15</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSMicrophoneUsageDescription</key>
    <string>crewchat needs microphone access to record voice messages</string>
    <key>NSPhotoLibraryUsageDescription</key>
    <string>crewchat needs photo library access to select images for analysis</string>
</dict>
</plist>
EOF

# Make executable
chmod +x "$MACOS_DIR/$APP_NAME"

echo "✅ Build complete: $APP_DIR"
echo ""
echo "📱 Launch with:"
echo "   open -a $APP_NAME"
echo "   or from SwiftBar: open crewchat://"
echo ""
echo "🔧 Features:"
echo "   • Mode picker for crew-lead, direct CLIs, and specialist agents"
echo "   • Per-agent + per-project chat history"
echo "   • Shows current engine per agent (OpenCode/Cursor/Claude/Direct)"
echo ""
echo "🚀 Opening app..."
open "$APP_DIR"
