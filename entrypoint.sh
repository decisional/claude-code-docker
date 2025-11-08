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

    # Only clone if the directory doesn't exist
    if [ ! -d "$TARGET_DIR" ]; then
        echo "Cloning repository to $TARGET_DIR..."

        # Clone with branch if specified
        if [ -n "$GIT_BRANCH" ]; then
            git clone --branch "$GIT_BRANCH" "$GIT_REPO_URL" "$TARGET_DIR"
            echo "Cloned branch: $GIT_BRANCH"
        else
            git clone "$GIT_REPO_URL" "$TARGET_DIR"
        fi

        echo "Repository cloned successfully!"
        cd "$TARGET_DIR"
    else
        echo "Repository already exists at $TARGET_DIR"
        cd "$TARGET_DIR"
    fi
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
