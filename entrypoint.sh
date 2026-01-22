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

    # Ensure parent directory exists and is writable
    mkdir -p "$(dirname "$TARGET_DIR")"

    # Clear any git environment variables that might interfere with cloning
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY
    unset GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CEILING_DIRECTORIES

    echo "Cloning repository to $TARGET_DIR..."

    # Determine clone strategy based on whether branch is specified and exists
    CLONE_BRANCH_ARG=""
    CREATE_NEW_BRANCH=false

    if [ -n "$GIT_BRANCH" ]; then
        # Check if branch exists remotely using git ls-remote
        if GIT_TERMINAL_PROMPT=0 git ls-remote --heads "$GIT_REPO_URL" "$GIT_BRANCH" 2>/dev/null | grep -q "refs/heads/$GIT_BRANCH"; then
            echo "✓ Branch '$GIT_BRANCH' exists remotely"
            CLONE_BRANCH_ARG="--branch $GIT_BRANCH"
        else
            echo "ℹ Branch '$GIT_BRANCH' does not exist remotely"
            echo "  Will create new branch from default branch"
            CREATE_NEW_BRANCH=true
        fi
    fi

    # Clone the repository
    if GIT_TERMINAL_PROMPT=0 git clone --config core.fsmonitor=false $CLONE_BRANCH_ARG "$GIT_REPO_URL" "$TARGET_DIR" 2>&1; then
        cd "$TARGET_DIR"

        # If we need to create a new branch, do it now
        if [ "$CREATE_NEW_BRANCH" = true ]; then
            if git checkout -b "$GIT_BRANCH" 2>&1; then
                echo "✓ Created new branch '$GIT_BRANCH' from default branch"
            else
                echo "❌ Failed to create branch '$GIT_BRANCH'"
                exit 1
            fi
        else
            [ -n "$GIT_BRANCH" ] && echo "✓ Cloned branch: $GIT_BRANCH" || echo "✓ Cloned repository using default branch"
        fi
    else
        CLONE_EXIT=$?

        # Check if directory was created despite error (partial clone)
        if [ -d "$TARGET_DIR/.git" ]; then
            echo "⚠ Clone completed but git reported an error (exit code: $CLONE_EXIT)"
            echo "  Repository appears to be intact, continuing..."
            cd "$TARGET_DIR"

            # If we still need to create the branch, try now
            if [ "$CREATE_NEW_BRANCH" = true ]; then
                if git checkout -b "$GIT_BRANCH" 2>&1; then
                    echo "✓ Created new branch '$GIT_BRANCH' from default branch"
                else
                    echo "❌ Failed to create branch '$GIT_BRANCH'"
                    exit 1
                fi
            fi

            # Fix any git state issues
            git fsck --full 2>&1 || echo "  (git fsck completed with warnings)"
        else
            echo "❌ Failed to clone repository (exit code: $CLONE_EXIT)"

            # Show what's in the workspace for debugging
            echo "Workspace contents:"
            ls -la /workspace/ 2>&1 || echo "Cannot list /workspace"

            exit 1
        fi
    fi

    echo "✓ Repository cloned successfully!"
    cd "$TARGET_DIR"

    # Install Python dependencies only if .venv is missing (volume may already have it)
    if [ -f "pyproject.toml" ] && [ ! -d ".venv" ]; then
        echo ""
        echo "📦 .venv missing - installing Python dependencies..."
        poetry install --no-interaction 2>&1 || echo "⚠ Poetry install had warnings (continuing anyway)"
        echo "✓ Python dependencies installed via Poetry"
    elif [ -d ".venv" ]; then
        echo "✓ Using existing .venv (from volume)"
    fi

    # Check for alakazam subdirectory - install only if .venv missing
    if [ -f "alakazam/pyproject.toml" ] && [ ! -d "alakazam/.venv" ]; then
        echo ""
        echo "📦 alakazam/.venv missing - installing alakazam dependencies..."
        (cd alakazam && poetry install --no-interaction 2>&1) || echo "⚠ alakazam Poetry install had warnings (continuing anyway)"
        echo "✓ alakazam dependencies installed via Poetry"
    elif [ -d "alakazam/.venv" ]; then
        echo "✓ Using existing alakazam/.venv (from volume)"
    fi

    # Auto-install Go dependencies if go.mod exists
    if [ -f "go.mod" ]; then
        echo ""
        echo "📦 Found go.mod - installing Go dependencies..."
        go mod download 2>&1 || echo "⚠ go mod download had warnings (continuing anyway)"
        echo "✓ Go dependencies installed"
    fi
else
    echo "No git repository configured (GIT_REPO_URL not set)"
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
