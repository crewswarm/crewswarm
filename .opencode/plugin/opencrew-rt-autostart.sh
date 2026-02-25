#!/bin/bash
# OpenCrew RT Auto-start script
# Add to Mac Login Items or launchd for boot persistence

PLUGIN_DIR="$HOME/swarm/.opencode/plugin"
PORT=18889

# Check if server already running
if curl -s "ws://127.0.0.1:$PORT" 2>/dev/null | grep -q "not HTTP"; then
    # WebSocket is there (expected response for non-HTTP)
    if curl -s "http://127.0.0.1:$PORT" 2>/dev/null | grep -q "connection refused\|nothing"; then
        echo "[opencrew-rt] Server already running on port $PORT"
        exit 0
    fi
fi

# Start the server
cd "$PLUGIN_DIR"
nohup node opencrew-rt-cli.mjs start > /tmp/opencrew-rt.log 2>&1 &
echo "[opencrew-rt] Started server on port $PORT"
