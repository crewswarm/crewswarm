#!/usr/bin/env bash

if [[ -n "${NODE:-}" && -x "${NODE}" ]]; then
  printf "%s\n" "$NODE"
  exit 0
fi

for candidate in \
  "/usr/local/opt/node/bin/node" \
  "/opt/homebrew/opt/node/bin/node" \
  "/usr/local/bin/node" \
  "/opt/homebrew/bin/node"
do
  if [[ -x "$candidate" ]]; then
    printf "%s\n" "$candidate"
    exit 0
  fi
done

if command -v node >/dev/null 2>&1; then
  command -v node
  exit 0
fi

exit 1
