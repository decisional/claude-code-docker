#!/bin/bash

# Build script for Claude Code Docker image
# Extracts credentials from macOS Keychain and builds them into the image
# Usage: build.sh [VERSION] [--no-cache]

set -e

# Parse arguments
VERSION="${1:-latest}"
NO_CACHE_FLAG=""
if [ "$2" = "--no-cache" ]; then
    NO_CACHE_FLAG="--no-cache"
fi

echo "Building Claude Code Docker Image (version: $VERSION)..."
echo "===================================="
echo ""

# Setup Git configuration files (needed for docker-compose volume mounts)
echo "1. Setting up Git configuration files..."
LOCAL_GIT_DIR="./git-data"
GIT_CONFIG="$HOME/.gitconfig"
SSH_DIR="$HOME/.ssh"

mkdir -p "$LOCAL_GIT_DIR"

# Copy gitconfig if it exists
if [ -f "$GIT_CONFIG" ]; then
    cp "$GIT_CONFIG" "$LOCAL_GIT_DIR/.gitconfig"
    echo "✅ Git config copied to $LOCAL_GIT_DIR/.gitconfig"
else
    # Create a basic gitconfig if none exists
    cat > "$LOCAL_GIT_DIR/.gitconfig" << 'EOF'
[init]
    defaultBranch = main
[user]
    # Configure your details:
    # name = Your Name
    # email = your.email@example.com
EOF
    echo "✅ Created basic Git config at $LOCAL_GIT_DIR/.gitconfig"
    echo "⚠️  IMPORTANT: Edit $LOCAL_GIT_DIR/.gitconfig to set your name and email"
fi

# Copy SSH keys if they exist (for git operations)
if [ -d "$SSH_DIR" ]; then
    mkdir -p "$LOCAL_GIT_DIR/.ssh"
    if [ -f "$SSH_DIR/id_rsa" ] || [ -f "$SSH_DIR/id_ed25519" ]; then
        cp -r "$SSH_DIR"/* "$LOCAL_GIT_DIR/.ssh/" 2>/dev/null || true
        chmod 700 "$LOCAL_GIT_DIR/.ssh"
        chmod 600 "$LOCAL_GIT_DIR/.ssh/"* 2>/dev/null || true
        echo "✅ SSH keys copied to $LOCAL_GIT_DIR/.ssh"
    else
        echo "⚠️  No SSH keys found in $SSH_DIR"
    fi
fi

# Copy GitHub CLI config if it exists
GH_CONFIG_DIR="$HOME/.config/gh"
if [ -d "$GH_CONFIG_DIR" ]; then
    mkdir -p "$LOCAL_GIT_DIR/.config/gh"
    cp -r "$GH_CONFIG_DIR"/* "$LOCAL_GIT_DIR/.config/gh/" 2>/dev/null || true
    echo "✅ GitHub CLI config copied to $LOCAL_GIT_DIR/.config/gh"
else
    echo "⚠️  No GitHub CLI config found at $GH_CONFIG_DIR"
    echo "   To enable GitHub CLI (for PR creation, etc.):"
    echo "   Option 1: Run 'gh auth login' on your host, then rebuild"
    echo "   Option 2: Add GITHUB_TOKEN to .env file (see .env.example)"
fi

# Create shared directory if it doesn't exist
if [ ! -d "./shared" ]; then
    mkdir -p ./shared
    echo "✅ Created shared directory"
fi

# Setup .env file if it doesn't exist
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo "✅ Created .env file from .env.example"
fi

# Auto-detect and set USER_ID and GROUP_ID in .env
CURRENT_UID=$(id -u)
CURRENT_GID=$(id -g)

if grep -q "^USER_ID=" .env; then
    # Update existing values
    sed -i.bak "s/^USER_ID=.*/USER_ID=${CURRENT_UID}/" .env
    sed -i.bak "s/^GROUP_ID=.*/GROUP_ID=${CURRENT_GID}/" .env
    rm -f .env.bak
else
    # Add new values
    echo "" >> .env
    echo "# Auto-detected user permissions" >> .env
    echo "USER_ID=${CURRENT_UID}" >> .env
    echo "GROUP_ID=${CURRENT_GID}" >> .env
fi

echo "✅ Set USER_ID=${CURRENT_UID} and GROUP_ID=${CURRENT_GID} in .env"

echo ""

# Extract credentials from macOS Keychain
echo "2. Extracting credentials from macOS Keychain..."
CREDENTIALS=$(security find-generic-password -s "Claude Code-credentials" -w 2>&1)

if [ -z "$CREDENTIALS" ] || echo "$CREDENTIALS" | grep -q "could not be found"; then
    echo "❌ Could not find Claude Code credentials in keychain"
    echo "Please run 'claude login' on your host machine first"
    exit 1
fi

echo "✅ Credentials extracted from keychain"

# Create temporary credentials file for Docker build
echo ""
echo "3. Creating temporary credentials file..."
mkdir -p ./.build-temp
echo "$CREDENTIALS" > ./.build-temp/.credentials.json
chmod 600 ./.build-temp/.credentials.json
echo "✅ Temporary credentials file created"

# Build Docker image with credentials
echo ""
echo "4. Building Docker image..."
docker build $NO_CACHE_FLAG \
    --build-arg USER_ID=${CURRENT_UID} \
    --build-arg GROUP_ID=${CURRENT_GID} \
    -t llm-docker-claude-code:${VERSION} \
    -t llm-docker-claude-code:latest \
    -f ./lib/Dockerfile .

echo ""
echo "5. Cleaning up temporary files..."
rm -rf ./.build-temp
echo "✅ Cleanup complete"

echo ""
echo "===================================="
echo "✅ Build complete!"
echo ""
echo "Credentials have been baked into the image."
echo "You can now run: docker-compose run --rm claude-code"
echo ""
