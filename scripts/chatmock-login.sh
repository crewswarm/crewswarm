#!/usr/bin/env bash
# One-time ChatMock login (ChatGPT account). Uses venv in ~/ChatMock.
set -e
CHATMOCK_DIR="${CHATMOCK_DIR:-$HOME/ChatMock}"
if [[ ! -d "$CHATMOCK_DIR" ]]; then
  echo "ChatMock not found at $CHATMOCK_DIR. Clone it first:"
  echo "  git clone https://github.com/RayBytes/ChatMock.git $CHATMOCK_DIR"
  exit 1
fi
cd "$CHATMOCK_DIR"
if [[ ! -d .venv ]]; then
  echo "Creating venv and installing dependencies..."
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
fi
exec .venv/bin/python chatmock.py login "$@"
