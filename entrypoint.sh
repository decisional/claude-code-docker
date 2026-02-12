#!/bin/bash

# Entrypoint script for LLM CLI Docker container (Claude Code or OpenAI Codex)
# Handles automatic git cloning if GIT_REPO_URL is set

set -e

# Function to install project dependencies (called after clone or pre-clone pull)
install_dependencies() {
    local dir="$1"

    # Auto-install Python dependencies if pyproject.toml exists (in background)
    if [ -f "$dir/pyproject.toml" ]; then
        echo ""
        echo "📦 Found pyproject.toml - installing Python dependencies in background..."
        (cd "$dir" && poetry install --no-interaction 2>&1 && echo "✓ Python dependencies installed via Poetry" || echo "⚠ Poetry install had warnings (continuing anyway)") &
    fi

    # Check for alakazam subdirectory with pyproject.toml (autodex repo, in background)
    if [ -f "$dir/alakazam/pyproject.toml" ]; then
        echo ""
        echo "📦 Found alakazam/pyproject.toml - installing alakazam dependencies in background..."
        (cd "$dir/alakazam" && poetry install --no-interaction 2>&1 && echo "✓ alakazam dependencies installed via Poetry" || echo "⚠ alakazam Poetry install had warnings (continuing anyway)") &
    fi

    # Auto-install Go dependencies if go.mod exists (in background)
    if [ -f "$dir/go.mod" ]; then
        echo ""
        echo "📦 Found go.mod - installing Go dependencies in background..."
        (cd "$dir" && go mod download 2>&1 && echo "✓ Go dependencies installed" || echo "⚠ go mod download had warnings (continuing anyway)") &
    fi

    # Auto-install Node.js dependencies if package.json exists
    if [ -f "$dir/package.json" ]; then
        echo ""
        echo "📦 Found package.json - installing Node.js dependencies..."

        # Install pg package immediately for PostgreSQL support (foreground)
        echo "Installing pg package..."
        (cd "$dir" && npm install pg --no-save 2>&1 && echo "✓ pg package ready" || echo "⚠ pg package installation failed")

        # Install other Node.js dependencies in background
        (cd "$dir" && npm install 2>&1 && echo "✓ Node.js dependencies installed") &
    fi
}

# Ensure Codex gets repo-scoped memory by syncing CLAUDE.md into AGENTS.md.
sync_codex_agents_from_claude() {
    local target_dir="$1"
    local source_file="${HOME}/.claude/CLAUDE.md"
    local target_file="${target_dir}/AGENTS.md"
    local marker_start="<!-- codex:memory:start -->"
    local marker_end="<!-- codex:memory:end -->"

    [ -f "$source_file" ] || return 0
    [ -d "$target_dir" ] || return 0

    if [ ! -f "$target_file" ]; then
        cp "$source_file" "$target_file"
        return 0
    fi

    if grep -q "$marker_start" "$target_file"; then
        awk -v start="$marker_start" -v end="$marker_end" -v src="$source_file" '
            $0==start {
                print
                while ((getline line < src) > 0) print line
                close(src)
                in_block=1
                next
            }
            $0==end { in_block=0 }
            !in_block { print }
        ' "$target_file" > "${target_file}.tmp" && mv "${target_file}.tmp" "$target_file"
        return 0
    fi

    {
        printf "\n%s\n" "$marker_start"
        cat "$source_file"
        printf "\n%s\n" "$marker_end"
    } >> "$target_file"
}

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

    # Check if repository already exists
    if [ -d "$TARGET_DIR/.git" ]; then
        # Repository already cloned, check if this is a reconnection or first-time setup
        SETUP_MARKER="/workspace/.initial-setup-complete"
        if [ -f "$SETUP_MARKER" ]; then
            # This is a reconnection to an existing container
            echo "Using existing repository at $TARGET_DIR"
            cd "$TARGET_DIR"
            echo "🔄 Updating repository to latest main..."
            git fetch origin main && git checkout main && git pull origin main && echo "✓ Updated to latest main" || echo "⚠ Could not update to main (may have local changes)"
        elif [ -f "/workspace/.build-cloned" ]; then
            # Repository was pre-cloned during image build - pull latest and install deps
            echo "📦 Using pre-cloned repository at $TARGET_DIR"
            cd "$TARGET_DIR"
            echo "🔄 Pulling latest changes..."
            git fetch origin main && git pull origin main && echo "✓ Updated to latest main" || echo "⚠ Could not pull latest (continuing with build-time snapshot)"

            # Handle branch switching if GIT_BRANCH is specified
            if [ -n "$GIT_BRANCH" ]; then
                if GIT_TERMINAL_PROMPT=0 git ls-remote --heads origin "$GIT_BRANCH" 2>/dev/null | grep -q "refs/heads/$GIT_BRANCH"; then
                    echo "Switching to branch '$GIT_BRANCH'..."
                    git fetch origin "$GIT_BRANCH" && git checkout "$GIT_BRANCH" && git pull origin "$GIT_BRANCH" \
                        && echo "✓ Switched to branch '$GIT_BRANCH'" \
                        || echo "⚠ Could not switch to branch '$GIT_BRANCH'"
                else
                    echo "Creating new branch '$GIT_BRANCH'..."
                    git checkout -b "$GIT_BRANCH" \
                        && echo "✓ Created new branch '$GIT_BRANCH'" \
                        || echo "⚠ Could not create branch '$GIT_BRANCH'"
                fi
            fi

            # Install project dependencies
            install_dependencies "$TARGET_DIR"

            echo ""
            echo "✓ Repository ready (pre-cloned)"

            # Mark initial setup as complete
            touch /workspace/.initial-setup-complete
            rm -f /workspace/.build-cloned
        fi
        # Otherwise, this is the second entrypoint call during initial setup - don't print anything
        cd "$TARGET_DIR"
    else
        # Repository doesn't exist or is not a valid git repo - clone it

        # Remove existing directory if it exists but is not a git repo
        if [ -d "$TARGET_DIR" ]; then
            echo "Removing invalid directory at $TARGET_DIR..."
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
        if GIT_TERMINAL_PROMPT=0 git clone --depth 1 --config core.fsmonitor=false $CLONE_BRANCH_ARG "$GIT_REPO_URL" "$TARGET_DIR" 2>&1; then
            cd "$TARGET_DIR"

            # Allow fetching all branches (shallow clone restricts to single branch refspec)
            git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'

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

        # Install project dependencies
        install_dependencies "$TARGET_DIR"

        # Mark initial setup as complete
        touch /workspace/.initial-setup-complete
    fi
else
    echo "No git repository configured (GIT_REPO_URL not set)"
fi

# Mark initial setup as complete (even if no git repo configured)
touch /workspace/.initial-setup-complete 2>/dev/null || true

# Sync memory into AGENTS.md for Codex runs.
if [ "$LLM_NAME" = "codex" ]; then
    if [ -n "$TARGET_DIR" ] && [ -d "$TARGET_DIR" ]; then
        sync_codex_agents_from_claude "$TARGET_DIR"
    else
        sync_codex_agents_from_claude "/workspace"
    fi
fi

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
