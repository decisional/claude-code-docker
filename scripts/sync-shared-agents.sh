#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_FILE="$REPO_ROOT/AGENTS.md"
DEST_DIR="$REPO_ROOT/shared"
DEST_FILE="$DEST_DIR/AGENTS.md"

if [ ! -f "$SOURCE_FILE" ]; then
    exit 0
fi

mkdir -p "$DEST_DIR"

if [ -f "$DEST_FILE" ] && cmp -s "$SOURCE_FILE" "$DEST_FILE"; then
    exit 0
fi

cp "$SOURCE_FILE" "$DEST_FILE"
echo "✓ Synced AGENTS.md to shared/AGENTS.md"
