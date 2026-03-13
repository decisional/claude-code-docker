#!/bin/bash

set -e

CONTAINER_NAME="${1:?container name required}"
WORKSPACE_DIR="${2:?workspace directory required}"

docker exec "$CONTAINER_NAME" sh -lc '
repo_dir="$1"

if [ ! -f /shared/AGENTS.md ]; then
    exit 0
fi

if [ ! -d "$repo_dir/.git" ]; then
    exit 0
fi

if [ -f "$repo_dir/AGENTS.md" ]; then
    exit 0
fi

cp /shared/AGENTS.md "$repo_dir/AGENTS.md"

exclude_file="$repo_dir/.git/info/exclude"
touch "$exclude_file"
if ! grep -qxF "AGENTS.md" "$exclude_file"; then
    printf "\nAGENTS.md\n" >> "$exclude_file"
fi

echo "✓ Installed shared AGENTS.md in $repo_dir"
' sh "$WORKSPACE_DIR"
