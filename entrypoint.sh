#!/bin/bash

# Entrypoint script for Claude Code Docker container
# Handles automatic git cloning if GIT_REPO_URL is set

set -e

echo "Claude Code Docker Environment"
echo "==============================="

# Ensure Claude credentials directory has correct permissions
CLAUDE_DIR="${HOME}/.claude"
if [ -d "$CLAUDE_DIR" ]; then
    # Fix permissions on credentials file if it exists
    if [ -f "$CLAUDE_DIR/.credentials.json" ]; then
        chmod 600 "$CLAUDE_DIR/.credentials.json" 2>/dev/null || true
        echo "✓ Claude credentials directory found"
        echo "  Credentials file: $(ls -lh $CLAUDE_DIR/.credentials.json | awk '{print $5, $6, $7, $8, $9}')"
    else
        echo "⚠ Warning: .credentials.json not found in $CLAUDE_DIR"
        echo "  Contents of $CLAUDE_DIR:"
        ls -la "$CLAUDE_DIR" | head -10
    fi
else
    echo "⚠ Warning: Claude credentials directory not found at $CLAUDE_DIR"
fi

# Authenticate GitHub CLI if token is provided
echo ""
if [ -n "$GITHUB_TOKEN" ]; then
    echo "Authenticating GitHub CLI..."
    if echo "$GITHUB_TOKEN" | gh auth login --with-token 2>/dev/null; then
        echo "✓ GitHub CLI authenticated successfully"
        gh auth status
    else
        echo "⚠ Warning: Failed to authenticate GitHub CLI with provided token"
    fi
elif gh auth status >/dev/null 2>&1; then
    echo "✓ GitHub CLI already authenticated (using existing config)"
else
    echo "⚠ GitHub CLI not authenticated"
    echo "  To enable PR creation and other GitHub operations:"
    echo "  1. Create a token at: https://github.com/settings/tokens"
    echo "  2. Add GITHUB_TOKEN=your_token to your .env file"
    echo "  3. Rebuild container with: ./cc-start"
fi

# Check if GIT_REPO_URL is set and workspace is empty
if [ -n "$GIT_REPO_URL" ]; then
    echo "Git repository configured: $GIT_REPO_URL"

    # Determine target directory
    if [ -n "$GIT_CLONE_DIR" ]; then
        TARGET_DIR="/workspace/$GIT_CLONE_DIR"
    else
        # Extract repo name from URL
        REPO_NAME=$(basename "$GIT_REPO_URL" .git)
        TARGET_DIR="/workspace/$REPO_NAME"
    fi

    # Always do a fresh clone to ensure clean state
    # Remove existing directory if it exists
    if [ -d "$TARGET_DIR" ]; then
        echo "Removing existing repository at $TARGET_DIR for fresh clone..."
        rm -rf "$TARGET_DIR"
    fi

    echo "Cloning repository to $TARGET_DIR..."

    # Default to main if no branch specified
    BRANCH="${GIT_BRANCH:-main}"

    # Try to clone with the specified branch
    if git clone --branch "$BRANCH" "$GIT_REPO_URL" "$TARGET_DIR" 2>/dev/null; then
        echo "✓ Cloned existing branch: $BRANCH"
    else
        echo "⚠ Branch '$BRANCH' doesn't exist remotely"
        echo "  Cloning default branch and creating '$BRANCH' from it..."

        # Remove failed clone attempt if any
        rm -rf "$TARGET_DIR" 2>/dev/null || true

        # Clone without specifying branch (uses default branch)
        if git clone "$GIT_REPO_URL" "$TARGET_DIR"; then
            cd "$TARGET_DIR"

            # Create and checkout new branch from current HEAD
            git checkout -b "$BRANCH"
            echo "✓ Created new branch '$BRANCH' from default branch"
        else
            echo "❌ Failed to clone repository"
            exit 1
        fi
    fi

    echo "✓ Repository cloned successfully!"
    cd "$TARGET_DIR"
else
    echo "No git repository configured (GIT_REPO_URL not set)"
fi

echo ""
echo "Working directory: $(pwd)"
echo ""

# Build Claude command with optional flags
if [ "$1" = "claude" ]; then
    CLAUDE_CMD="claude"

    # Add --dangerously-skip-permissions if enabled
    # This bypasses all permission checks (includes both skip-permissions and dangerously)
    if [ "$CLAUDE_SKIP_PERMISSIONS" = "true" ]; then
        CLAUDE_CMD="$CLAUDE_CMD --dangerously-skip-permissions"
        echo "⚠️  Running with --dangerously-skip-permissions flag"
        echo "    This bypasses all permission checks - use only in trusted sandboxes"
    fi

    shift
    echo ""
    exec $CLAUDE_CMD "$@"
else
    # Execute the command passed to the container as-is
    exec "$@"
fi
