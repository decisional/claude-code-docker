#!/bin/bash

# Entrypoint script for LLM CLI Docker container (Claude Code or OpenAI Codex)
# Handles automatic git cloning if GIT_REPO_URL is set

set -e

# Determine which LLM we're using
LLM_NAME="${LLM_TYPE:-claude}"
if [ "$LLM_NAME" = "codex" ]; then
    echo "OpenAI Codex CLI Docker Environment"
else
    echo "Claude Code Docker Environment"
fi
echo "==============================="

# Check credentials based on LLM type
if [ "$LLM_NAME" = "codex" ]; then
    # Check for Codex authentication
    CODEX_AUTH="${HOME}/.codex/auth.json"
    if [ -f "$CODEX_AUTH" ]; then
        chmod 600 "$CODEX_AUTH" 2>/dev/null || true
        echo "✓ Codex credentials found"
        echo "  Auth file: $(ls -lh $CODEX_AUTH | awk '{print $5, $6, $7, $8, $9}')"
    elif [ -n "$OPENAI_API_KEY" ]; then
        echo "✓ OpenAI API key found in environment"
    else
        echo "⚠ Warning: Codex authentication not found"
        echo "  To authenticate Codex CLI:"
        echo "  1. Run 'codex' on your host machine and login, then rebuild with ./build.sh, or"
        echo "  2. Set OPENAI_API_KEY environment variable in .env"
    fi
else
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
fi

# Check GitHub CLI authentication
echo ""
if [ -n "$GITHUB_TOKEN" ]; then
    if gh auth status >/dev/null 2>&1; then
        echo "✓ GitHub CLI authenticated via GITHUB_TOKEN"
    else
        echo "⚠ GITHUB_TOKEN set but invalid"
    fi
elif gh auth status >/dev/null 2>&1; then
    echo "✓ GitHub CLI authenticated (using existing config)"
else
    echo "⚠ GitHub CLI not authenticated"
    echo "  To enable PR creation: add GITHUB_TOKEN to .env file"
fi

# Clone repo if GIT_REPO_URL is set
if [ -n "$GIT_REPO_URL" ]; then
    TARGET_DIR="/workspace/${GIT_CLONE_DIR:-$(basename "$GIT_REPO_URL" .git)}"

    if [ -d "$TARGET_DIR/.git" ]; then
        echo "✓ Repository exists at $TARGET_DIR"
    else
        echo "Cloning $GIT_REPO_URL..."
        git clone "$GIT_REPO_URL" "$TARGET_DIR" 2>&1 || { echo "❌ Clone failed"; exit 1; }
        echo "✓ Cloned"
    fi

    cd "$TARGET_DIR"

    # Install deps if .venv missing
    [ -f "pyproject.toml" ] && [ ! -d ".venv" ] && poetry install --no-interaction 2>&1 || true
    [ -f "alakazam/pyproject.toml" ] && [ ! -d "alakazam/.venv" ] && (cd alakazam && poetry install --no-interaction 2>&1) || true
    [ -d ".venv" ] && echo "✓ .venv ready"
    [ -d "alakazam/.venv" ] && echo "✓ alakazam/.venv ready"
else
    echo "No GIT_REPO_URL set"
fi

# Mark initial setup as complete (even if no git repo configured)
touch /workspace/.initial-setup-complete 2>/dev/null || true

echo ""
echo "Working directory: $(pwd)"
echo ""

# Determine which LLM CLI to launch
if [ "$1" = "llm" ] || [ "$1" = "claude" ] || [ "$1" = "codex" ]; then
    # Override LLM_NAME if specific command is given
    if [ "$1" = "claude" ]; then
        LLM_NAME="claude"
    elif [ "$1" = "codex" ]; then
        LLM_NAME="codex"
    fi

    if [ "$LLM_NAME" = "codex" ]; then
        # Launch OpenAI Codex CLI
        LLM_CMD="codex"

        # Add --yolo flag if enabled (full bypass mode)
        # This disables all approval prompts and sandboxing
        if [ "$CODEX_YOLO" = "true" ]; then
            LLM_CMD="$LLM_CMD --yolo"
            echo "⚠️  Running with --yolo flag"
            echo "    This bypasses all approval prompts and sandboxing - use only in trusted environments"
        # Or add --ask-for-approval never for just disabling prompts
        elif [ "$CODEX_NO_APPROVAL" = "true" ]; then
            LLM_CMD="$LLM_CMD --ask-for-approval never"
            echo "⚠️  Running with --ask-for-approval never flag"
            echo "    This disables approval prompts for all operations"
        fi

        shift
        echo ""
        exec $LLM_CMD "$@"
    else
        # Launch Claude Code CLI
        LLM_CMD="claude"

        # Add --dangerously-skip-permissions if enabled
        # This bypasses all permission checks (includes both skip-permissions and dangerously)
        if [ "$CLAUDE_SKIP_PERMISSIONS" = "true" ]; then
            LLM_CMD="$LLM_CMD --dangerously-skip-permissions"
            echo "⚠️  Running with --dangerously-skip-permissions flag"
            echo "    This bypasses all permission checks - use only in trusted sandboxes"
        fi

        shift
        echo ""
        exec $LLM_CMD "$@"
    fi
else
    # Execute the command passed to the container as-is
    exec "$@"
fi
