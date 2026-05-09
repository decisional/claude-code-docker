#!/bin/bash

# Entrypoint script for LLM CLI Docker container (Claude Code or OpenAI Codex)
# Handles automatic git cloning if GIT_REPO_URL is set

set -e

detect_node_package_manager() {
    local dir="$1"
    local package_manager=""

    if [ ! -f "$dir/package.json" ]; then
        return 1
    fi

    if [ -f "$dir/pnpm-lock.yaml" ] || [ -f "$dir/pnpm-workspace.yaml" ]; then
        echo "pnpm"
        return 0
    fi

    if [ -f "$dir/yarn.lock" ]; then
        echo "yarn"
        return 0
    fi

    if [ -f "$dir/package-lock.json" ] || [ -f "$dir/npm-shrinkwrap.json" ]; then
        echo "npm"
        return 0
    fi

    package_manager=$(
        cd "$dir" && \
        node -e 'try { const pkg = require("./package.json"); process.stdout.write(String(pkg.packageManager || "").split("@")[0]); } catch {}' 2>/dev/null || true
    )

    case "$package_manager" in
        pnpm|yarn|npm)
            echo "$package_manager"
            ;;
        *)
            echo "npm"
            ;;
    esac
}

install_node_dependencies() {
    local dir="$1"
    local package_manager="$2"

    echo ""
    echo "📦 Found package.json - installing Node.js dependencies with $package_manager in background..."

    case "$package_manager" in
        pnpm)
            (
                (
                    cd "$dir" && \
                    if [ -f pnpm-lock.yaml ]; then
                        corepack pnpm install --frozen-lockfile
                    else
                        corepack pnpm install
                    fi
                ) 2>&1 && echo "✓ Node.js dependencies installed via pnpm" || echo "⚠ pnpm install had warnings (continuing anyway)"
            ) &
            ;;
        yarn)
            (
                (
                    cd "$dir" && \
                    if [ -f yarn.lock ]; then
                        corepack yarn install --immutable
                    else
                        corepack yarn install
                    fi
                ) 2>&1 && echo "✓ Node.js dependencies installed via yarn" || echo "⚠ yarn install had warnings (continuing anyway)"
            ) &
            ;;
        *)
            (
                (
                    cd "$dir" && \
                    if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then
                        npm ci
                    else
                        npm install
                    fi
                ) 2>&1 && echo "✓ Node.js dependencies installed via npm" || echo "⚠ npm install had warnings (continuing anyway)"
            ) &
            ;;
    esac
}

is_poetry_project() {
    local dir="$1"

    [ -f "$dir/pyproject.toml" ] || return 1
    [ -f "$dir/poetry.lock" ] && return 0
    grep -Eq '^\[tool\.poetry(\.|])' "$dir/pyproject.toml"
}

# Function to install project dependencies (called after clone or pre-clone pull)
install_dependencies() {
    local dir="$1"

    # Auto-install Python dependencies for Poetry-managed projects (in background)
    if is_poetry_project "$dir"; then
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

    # Install pre-commit hooks if .pre-commit-config.yaml exists (in background)
    if [ -f "$dir/.pre-commit-config.yaml" ]; then
        echo ""
        echo "📦 Found .pre-commit-config.yaml - installing pre-commit hooks in background..."
        (cd "$dir" && pre-commit install 2>&1 && echo "✓ Pre-commit hooks installed" || echo "⚠ Pre-commit hook installation failed") &
    fi

    # Auto-install Node.js dependencies if package.json exists
    if [ -f "$dir/package.json" ]; then
        local package_manager
        package_manager=$(detect_node_package_manager "$dir")
        install_node_dependencies "$dir" "$package_manager"
    fi
}

confirm_dangerous_startup_prompt() {
    local tmux_conf="$1"
    local tmux_session="$2"
    local confirm_key="$3"
    local attempts=40
    local pane_text=""

    [ -n "$confirm_key" ] || return 0

    while [ "$attempts" -gt 0 ]; do
        if ! tmux -f "$tmux_conf" has-session -t "$tmux_session" 2>/dev/null; then
            return 0
        fi

        pane_text=$(tmux -f "$tmux_conf" capture-pane -p -t "$tmux_session" -S -80 2>/dev/null || true)

        if printf "%s\n" "$pane_text" | grep -Eiq "danger|bypass|skip[- ]permissions|sandbox|unsafe"; then
            if printf "%s\n" "$pane_text" | grep -Eiq "allow|exit|continue"; then
                tmux -f "$tmux_conf" send-keys -t "$tmux_session" "$confirm_key"
                return 0
            fi
        fi

        sleep 0.25
        attempts=$((attempts - 1))
    done
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

# Ensure browser tooling has writable XDG directories before startup.
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}" "${XDG_CACHE_HOME:-$HOME/.cache}" "$PLAYWRIGHT_BROWSERS_PATH"

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
            if [ "$RESET_TO_MAIN" = "true" ]; then
                echo "🔄 Resetting to latest main..."
                git fetch origin main && git checkout main && git pull origin main && echo "✓ Reset to latest main" || echo "⚠ Could not reset to main (may have local changes)"
            else
                echo "✓ Preserving current branch: $(git branch --show-current)"
            fi
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

    DANGEROUS_PROMPT_CHOICE=""

    if [ "$LLM_NAME" = "codex" ]; then
        # Launch OpenAI Codex CLI
        LLM_CMD="codex"

        # Codex inside the desktop app is already wrapped by tmux. Inline mode
        # preserves scrollback and avoids trapping the live composer off-screen.
        if [ "${CODEX_NO_ALT_SCREEN:-true}" != "false" ]; then
            LLM_CMD="$LLM_CMD --no-alt-screen"
        fi

        # Add --yolo flag if enabled (full bypass mode)
        # This disables all approval prompts and sandboxing
        if [ "$CODEX_YOLO" = "true" ]; then
            LLM_CMD="$LLM_CMD --yolo"
            DANGEROUS_PROMPT_CHOICE="1"
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
    else
        # Launch Claude Code CLI
        LLM_CMD="claude"

        # Add --dangerously-skip-permissions if enabled
        # This bypasses all permission checks (includes both skip-permissions and dangerously)
        if [ "$CLAUDE_SKIP_PERMISSIONS" = "true" ]; then
            LLM_CMD="$LLM_CMD --dangerously-skip-permissions"
            DANGEROUS_PROMPT_CHOICE="2"
            echo "⚠️  Running with --dangerously-skip-permissions flag"
            echo "    This bypasses all permission checks - use only in trusted sandboxes"
        fi

        shift
        echo ""
    fi

    if [ "$USE_TMUX" = "true" ]; then
        # The desktop app opts into tmux so the CLI process survives PTY disconnects.
        TMUX_SESSION="llm-session"

        # Configure tmux: hide status bar so it looks like a normal terminal.
        export TMUX_CONF="/tmp/.tmux.conf"
        cat > "$TMUX_CONF" <<'TMUXCONF'
set -g status off
set -g mouse on
set -g default-terminal "xterm-256color"
set -g aggressive-resize on

# Scroll 1 line per wheel event instead of the default 5 so that the
# desktop app's throttled wheel handler produces smooth, continuous
# scrolling rather than jerky 5-line jumps.
bind -n WheelUpPane if-shell -F -t = "#{pane_in_mode}" "send-keys -X scroll-up" "copy-mode -e; send-keys -X scroll-up"
bind -n WheelDownPane if-shell -F -t = "#{pane_in_mode}" "send-keys -X scroll-down"
TMUXCONF

        # On reset (RESET_TO_MAIN=true), kill the old tmux session so we get a fresh CLI.
        if [ "$RESET_TO_MAIN" = "true" ] && tmux -f "$TMUX_CONF" has-session -t "$TMUX_SESSION" 2>/dev/null; then
            echo "🗑  Ending previous session for reset..."
            tmux -f "$TMUX_CONF" kill-session -t "$TMUX_SESSION" 2>/dev/null || true
        fi

        if tmux -f "$TMUX_CONF" has-session -t "$TMUX_SESSION" 2>/dev/null; then
            echo "🔄 Reattaching to existing session..."
            echo ""
            exec tmux -u -f "$TMUX_CONF" attach-session -d -t "$TMUX_SESSION"
        else
            echo "▶ Starting new session in tmux..."
            echo ""
            # Start detached so we can send /effort max before attaching
            tmux -u -f "$TMUX_CONF" new-session -d -s "$TMUX_SESSION" "$LLM_CMD $*"
            confirm_dangerous_startup_prompt "$TMUX_CONF" "$TMUX_SESSION" "$DANGEROUS_PROMPT_CHOICE"
            if [ "$LLM_NAME" = "claude" ]; then
                sleep 3
                # If the CLI crashed during startup the tmux session is already
                # gone. Fall back to running it in the foreground so the user
                # sees the real error instead of tmux's "can't find session".
                if ! tmux -f "$TMUX_CONF" has-session -t "$TMUX_SESSION" 2>/dev/null; then
                    echo "⚠ tmux session exited before startup completed; re-running without tmux to surface the error."
                    exec $LLM_CMD "$@"
                fi
                tmux -f "$TMUX_CONF" send-keys -t "$TMUX_SESSION" "/effort max" Enter
                sleep 1
            fi
            # Same guard before attach: if the session died between the
            # send-keys delay and here, attach would error under set -e.
            if ! tmux -f "$TMUX_CONF" has-session -t "$TMUX_SESSION" 2>/dev/null; then
                echo "⚠ tmux session exited before attach; re-running without tmux to surface the error."
                exec $LLM_CMD "$@"
            fi
            exec tmux -u -f "$TMUX_CONF" attach-session -d -t "$TMUX_SESSION"
        fi
    fi

    exec $LLM_CMD "$@"
else
    # Execute the command passed to the container as-is
    exec "$@"
fi
