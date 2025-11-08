#!/bin/bash

# Export Claude Code credentials from macOS keychain to Docker volume
# This allows containers to use your existing authentication

set -e

echo "Exporting Claude Code credentials from macOS Keychain..."
echo "========================================================="
echo ""

# Try to find the credentials in keychain
echo "Searching for Claude Code credentials in keychain..."

# The credentials might be stored as "Claude Safe Storage" or similar
# We need to find the exact service name

KEYCHAIN_ENTRY=$(security find-generic-password -l "Claude Code-credentials" -g 2>&1 || true)

if echo "$KEYCHAIN_ENTRY" | grep -q "could not be found"; then
    echo "❌ Could not find Claude Code credentials in keychain"
    echo ""
    echo "This is expected on macOS. Claude Code stores credentials in the system keychain,"
    echo "which Docker containers cannot access."
    echo ""
    echo "SOLUTION: Authenticate once inside the container:"
    echo "  1. docker-compose up -d"
    echo "  2. docker exec -it claude-code-env claude"
    echo "  3. Login when prompted"
    echo ""
    echo "Your credentials will be saved to ./claude-data/.credentials.json"
    echo "and will persist for future container runs."
    exit 0
fi

echo "✅ Found credentials in keychain"
echo ""
echo "Note: macOS Keychain credentials cannot be directly exported to Docker."
echo "You'll need to authenticate once inside the container."
echo ""
echo "Run: docker exec -it claude-code-env claude"
