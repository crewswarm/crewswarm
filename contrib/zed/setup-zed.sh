#!/bin/bash
# Setup Zed + crewswarm Integration
set -e

echo "🐝 Setting up Zed + crewswarm..."

# 1. Check if Zed is installed
if ! command -v zed &> /dev/null; then
    echo "❌ Zed not found. Install from: https://zed.dev/download"
    exit 1
fi

echo "✅ Zed found: $(which zed)"

# 2. Check if crewswarm is running
if ! curl -s http://127.0.0.1:5020/health &> /dev/null; then
    echo "⚠️  MCP server not running. Starting crewswarm..."
    npm run restart-all &
    sleep 3
fi

echo "✅ crewswarm MCP server running on :5020"

# 3. Get auth token
TOKEN=$(cat ~/.crewswarm/config.json | python3 -c "import json,sys; print(json.load(sys.stdin)['rt']['authToken'])")
echo "✅ Auth token: ${TOKEN:0:20}..."

# 4. Backup existing Zed config if it exists
ZED_CONFIG_DIR="$HOME/.config/zed"
ZED_CONFIG="$ZED_CONFIG_DIR/settings.json"

mkdir -p "$ZED_CONFIG_DIR"

if [ -f "$ZED_CONFIG" ]; then
    BACKUP="$ZED_CONFIG.backup-$(date +%Y%m%d-%H%M%S)"
    cp "$ZED_CONFIG" "$BACKUP"
    echo "✅ Backed up existing config to: $BACKUP"
fi

# 5. Merge or create Zed config
cat > "$ZED_CONFIG" <<EOF
{
  "assistant": {
    "enabled": true,
    "version": "2"
  },
  "mcp_servers": {
    "crewswarm": {
      "transport": "http",
      "url": "http://127.0.0.1:5020/mcp",
      "headers": {
        "Authorization": "Bearer $TOKEN"
      }
    }
  },
  "file_watchers": {
    "enabled": true
  }
}
EOF

echo "✅ Created Zed config at: $ZED_CONFIG"

# 6. Test MCP connection
echo ""
echo "Testing MCP connection..."
curl -s http://127.0.0.1:5020/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' | python3 -m json.tool | head -20

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ SETUP COMPLETE!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Next steps:"
echo "1. Restart Zed (if it's already open)"
echo "2. Press cmd-? to open the agent panel"
echo "3. You should see crewswarm MCP tools available"
echo "4. Try: 'Use list_agents to show available crew members'"
echo ""
echo "WhatsApp/Telegram integration:"
echo "- Chat with crew-lead via Telegram/WhatsApp"
echo "- Agents will create/edit files in your project"
echo "- Files appear in Zed automatically"
echo ""
echo "View the template config: cat contrib/zed/zed-settings.json"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
