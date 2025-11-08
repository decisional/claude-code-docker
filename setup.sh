#!/bin/bash

# Setup script for Claude Code Docker environment
# This copies your Claude credentials and Git config to local directories for writable access

set -e

CLAUDE_DIR="$HOME/.claude"
LOCAL_CLAUDE_DIR="./claude-data"
GIT_CONFIG="$HOME/.gitconfig"
LOCAL_GIT_DIR="./git-data"
SSH_DIR="$HOME/.ssh"

echo "Setting up Claude Code Docker environment..."

# Check if Claude credentials exist
if [ ! -d "$CLAUDE_DIR" ]; then
    echo "Error: Claude credentials not found at $CLAUDE_DIR"
    echo "Please run 'claude login' first on your host machine."
    exit 1
fi

# Create local Claude data directory
if [ -d "$LOCAL_CLAUDE_DIR" ]; then
    echo "Warning: $LOCAL_CLAUDE_DIR already exists."
    read -p "Do you want to overwrite it with fresh credentials? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Skipping credentials copy. Using existing data."
    else
        rm -rf "$LOCAL_CLAUDE_DIR"
        mkdir -p "$LOCAL_CLAUDE_DIR"
        cp -r "$CLAUDE_DIR"/* "$LOCAL_CLAUDE_DIR"/
        echo "Credentials copied to $LOCAL_CLAUDE_DIR"
    fi
else
    mkdir -p "$LOCAL_CLAUDE_DIR"
    cp -r "$CLAUDE_DIR"/* "$LOCAL_CLAUDE_DIR"/
    echo "Credentials copied to $LOCAL_CLAUDE_DIR"
fi

# Setup Git configuration
echo ""
echo "Setting up Git configuration..."
mkdir -p "$LOCAL_GIT_DIR"

# Copy gitconfig if it exists
if [ -f "$GIT_CONFIG" ]; then
    cp "$GIT_CONFIG" "$LOCAL_GIT_DIR/.gitconfig"
    echo "Git config copied to $LOCAL_GIT_DIR/.gitconfig"
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
    echo "Created basic Git config at $LOCAL_GIT_DIR/.gitconfig"
    echo "IMPORTANT: Edit $LOCAL_GIT_DIR/.gitconfig to set your name and email"
fi

# Copy SSH keys if they exist (for git operations)
if [ -d "$SSH_DIR" ]; then
    mkdir -p "$LOCAL_GIT_DIR/.ssh"
    if [ -f "$SSH_DIR/id_rsa" ] || [ -f "$SSH_DIR/id_ed25519" ]; then
        cp -r "$SSH_DIR"/* "$LOCAL_GIT_DIR/.ssh/" 2>/dev/null || true
        chmod 700 "$LOCAL_GIT_DIR/.ssh"
        chmod 600 "$LOCAL_GIT_DIR/.ssh/"* 2>/dev/null || true
        echo "SSH keys copied to $LOCAL_GIT_DIR/.ssh"
    else
        echo "No SSH keys found in $SSH_DIR"
    fi
fi

# Create workspace directory if it doesn't exist
if [ ! -d "./workspace" ]; then
    mkdir -p ./workspace
    echo "Created workspace directory"
fi

# Setup .env file for git repository configuration
echo ""
echo "Setting up .env file..."
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo "Created .env file from .env.example"
    echo ""
    echo "OPTIONAL: Configure git repository to auto-clone"
    read -p "Do you want to configure a git repository to auto-clone? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        read -p "Enter git repository URL (e.g., git@github.com:user/repo.git): " GIT_URL
        if [ -n "$GIT_URL" ]; then
            echo "GIT_REPO_URL=$GIT_URL" >> .env
            echo "Git repository configured: $GIT_URL"

            read -p "Enter branch name (press Enter for default): " GIT_BR
            if [ -n "$GIT_BR" ]; then
                echo "GIT_BRANCH=$GIT_BR" >> .env
            fi
        fi
    else
        echo "Skipping git repository configuration. You can edit .env later to add it."
    fi
else
    echo ".env file already exists. Skipping creation."
fi

echo ""
echo "Setup complete!"
echo "You can now run: docker-compose run --rm claude-code"
echo ""
echo "Notes:"
echo "  - Claude memories and settings will be saved to $LOCAL_CLAUDE_DIR"
echo "  - Git config and SSH keys are in $LOCAL_GIT_DIR (writable)"
echo "  - Your original ~/.claude and ~/.gitconfig remain unchanged"
echo "  - Edit .env to configure automatic git repository cloning"
