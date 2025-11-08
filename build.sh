#!/bin/bash

# Build script for Claude Code Docker image
# Extracts credentials from macOS Keychain and builds them into the image

set -e

echo "Building Claude Code Docker Image..."
echo "===================================="
echo ""

# Extract credentials from macOS Keychain
echo "1. Extracting credentials from macOS Keychain..."
CREDENTIALS=$(security find-generic-password -s "Claude Code-credentials" -w 2>&1)

if [ -z "$CREDENTIALS" ] || echo "$CREDENTIALS" | grep -q "could not be found"; then
    echo "❌ Could not find Claude Code credentials in keychain"
    echo "Please run 'claude login' on your host machine first"
    exit 1
fi

echo "✅ Credentials extracted from keychain"

# Create temporary credentials file for Docker build
echo ""
echo "2. Creating temporary credentials file..."
mkdir -p ./.build-temp
echo "$CREDENTIALS" > ./.build-temp/.credentials.json
chmod 600 ./.build-temp/.credentials.json
echo "✅ Temporary credentials file created"

# Build Docker image with credentials
echo ""
echo "3. Building Docker image..."
docker-compose build --no-cache

echo ""
echo "4. Cleaning up temporary files..."
rm -rf ./.build-temp
echo "✅ Cleanup complete"

echo ""
echo "===================================="
echo "✅ Build complete!"
echo ""
echo "Credentials have been baked into the image."
echo "You can now run: docker-compose run --rm claude-code"
echo ""
