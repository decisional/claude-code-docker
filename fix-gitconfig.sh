#!/bin/bash

# Fix script for .gitconfig directory issue
# Removes incorrectly created .gitconfig directory and creates proper file

set -e

echo "Fixing .gitconfig directory issue..."
echo "===================================="
echo ""

LOCAL_GIT_DIR="./git-data"
GITCONFIG_PATH="$LOCAL_GIT_DIR/.gitconfig"

# Check if .gitconfig exists and is a directory
if [ -d "$GITCONFIG_PATH" ] && [ ! -L "$GITCONFIG_PATH" ]; then
    echo "⚠️  Found .gitconfig as directory (this is the problem)"
    echo "Removing incorrect directory..."
    rm -rf "$GITCONFIG_PATH"
    echo "✅ Removed .gitconfig directory"
    echo ""
fi

# Now run the build script which will create it properly
echo "Running build.sh to set up everything correctly..."
echo ""
./build.sh
