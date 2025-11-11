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
    # Remove existing directory if it exists with thorough cleanup
    if [ -d "$TARGET_DIR" ]; then
        echo "Removing existing repository at $TARGET_DIR for fresh clone..."
        # Force remove with verbose error handling
        if ! rm -rf "$TARGET_DIR" 2>&1; then
            echo "⚠ Warning: Failed to remove $TARGET_DIR, retrying with force..."
            chmod -R u+w "$TARGET_DIR" 2>/dev/null || true
            rm -rf "$TARGET_DIR" || true
        fi

        # Verify removal was successful
        if [ -d "$TARGET_DIR" ]; then
            echo "❌ Error: Could not remove $TARGET_DIR"
            exit 1
        fi
    fi

    # Ensure parent directory exists and is writable
    mkdir -p "$(dirname "$TARGET_DIR")"

    # Clear any git environment variables that might interfere with cloning
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY
    unset GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CEILING_DIRECTORIES

    echo "Cloning repository to $TARGET_DIR..."

    # If GIT_BRANCH is specified, try to clone that branch
    if [ -n "$GIT_BRANCH" ]; then
        # Try to clone the specified branch with explicit config
        if GIT_TERMINAL_PROMPT=0 git clone --config core.fsmonitor=false --branch "$GIT_BRANCH" "$GIT_REPO_URL" "$TARGET_DIR" 2>&1; then
            echo "✓ Cloned existing branch: $GIT_BRANCH"
        else
            CLONE_EXIT=$?

            # Check if it's actually a missing branch vs clone error
            if [ -d "$TARGET_DIR/.git" ]; then
                echo "⚠ Clone completed but git reported an error (exit code: $CLONE_EXIT)"
                echo "  Repository appears to be intact, continuing..."
                cd "$TARGET_DIR"
            else
                echo "⚠ Branch '$GIT_BRANCH' doesn't exist remotely (exit code: $CLONE_EXIT)"
                echo "  Cloning default branch and creating '$GIT_BRANCH' from it..."

                # Thorough cleanup of failed clone attempt
                if [ -d "$TARGET_DIR" ]; then
                    chmod -R u+w "$TARGET_DIR" 2>/dev/null || true
                    rm -rf "$TARGET_DIR" 2>&1 || true
                fi

                # Clone without specifying branch (uses repo's default branch)
                if GIT_TERMINAL_PROMPT=0 git clone --config core.fsmonitor=false "$GIT_REPO_URL" "$TARGET_DIR" 2>&1; then
                    cd "$TARGET_DIR"

                    # Create and checkout new branch from current HEAD
                    if git checkout -b "$GIT_BRANCH" 2>&1; then
                        echo "✓ Created new branch '$GIT_BRANCH' from default branch"
                    else
                        echo "❌ Failed to create branch '$GIT_BRANCH'"
                        exit 1
                    fi
                else
                    # Check if clone succeeded despite error
                    if [ -d "$TARGET_DIR/.git" ]; then
                        echo "⚠ Clone completed but git reported an error"
                        echo "  Repository appears to be intact, continuing..."
                        cd "$TARGET_DIR"

                        # Create and checkout new branch
                        if git checkout -b "$GIT_BRANCH" 2>&1; then
                            echo "✓ Created new branch '$GIT_BRANCH' from default branch"
                        else
                            echo "❌ Failed to create branch '$GIT_BRANCH'"
                            exit 1
                        fi
                    else
                        echo "❌ Failed to clone repository"
                        exit 1
                    fi
                fi
            fi
        fi
    else
        # No branch specified - clone using repo's default branch
        # Clone with explicit config to avoid git internal errors
        if GIT_TERMINAL_PROMPT=0 git clone --config core.fsmonitor=false "$GIT_REPO_URL" "$TARGET_DIR" 2>&1; then
            echo "✓ Cloned repository using default branch"
        else
            CLONE_EXIT=$?

            # Check if directory was created despite error (partial clone)
            if [ -d "$TARGET_DIR/.git" ]; then
                echo "⚠ Clone completed but git reported an error (exit code: $CLONE_EXIT)"
                echo "  Repository appears to be intact, continuing..."

                # Fix any git state issues
                cd "$TARGET_DIR"
                git fsck --full 2>&1 || echo "  (git fsck completed with warnings)"
            else
                echo "❌ Failed to clone repository (exit code: $CLONE_EXIT)"

                # Show what's in the workspace for debugging
                echo "Workspace contents:"
                ls -la /workspace/ 2>&1 || echo "Cannot list /workspace"

                exit 1
            fi
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
