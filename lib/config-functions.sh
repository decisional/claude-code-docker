#!/bin/bash

# Configuration functions for Claude Code CLI
# This file provides auto-detection, interactive prompts, and config management

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Determine installation prefix
if [ -n "$CLAUDE_CODE_HOME" ]; then
    INSTALL_PREFIX="$CLAUDE_CODE_HOME"
elif [ -d "/usr/local/opt/claude-code" ]; then
    INSTALL_PREFIX="/usr/local/opt/claude-code"
elif [ -d "/opt/homebrew/opt/claude-code" ]; then
    INSTALL_PREFIX="/opt/homebrew/opt/claude-code"
else
    # Running from source/development
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    INSTALL_PREFIX="$SCRIPT_DIR"
fi

LIB_DIR="$INSTALL_PREFIX/lib"
CONFIG_DIR=".claude-code"
CONFIG_FILE="$CONFIG_DIR/config"

# Get the project-specific config directory path
get_config_dir() {
    echo "$PWD/$CONFIG_DIR"
}

# Get the project-specific config file path
get_config_file() {
    echo "$PWD/$CONFIG_FILE"
}

# Check if config file exists
config_exists() {
    [ -f "$(get_config_file)" ]
}

# Load configuration from file
load_config() {
    local config_file="$(get_config_file)"
    if [ -f "$config_file" ]; then
        source "$config_file"
        return 0
    fi
    return 1
}

# Save configuration to file
save_config() {
    local config_file="$(get_config_file)"
    local config_dir="$(get_config_dir)"

    mkdir -p "$config_dir"

    cat > "$config_file" << EOF
# Claude Code Configuration
# Generated on $(date)

GIT_REPO_URL="$GIT_REPO_URL"
GIT_BRANCH="$GIT_BRANCH"
GIT_CLONE_DIR="$GIT_CLONE_DIR"
CLAUDE_SKIP_PERMISSIONS="${CLAUDE_SKIP_PERMISSIONS:-false}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
EOF

    echo -e "${GREEN}✓${NC} Configuration saved to $config_file"
}

# Auto-detect git repository URL
detect_git_repo() {
    if git rev-parse --git-dir > /dev/null 2>&1; then
        git config --get remote.origin.url 2>/dev/null
    fi
}

# Auto-detect current git branch
detect_git_branch() {
    if git rev-parse --git-dir > /dev/null 2>&1; then
        git branch --show-current 2>/dev/null
    fi
}

# Auto-detect project name from directory
detect_project_name() {
    basename "$PWD"
}

# Prompt user for input with default value
prompt_with_default() {
    local prompt_text="$1"
    local default_value="$2"
    local result

    if [ -n "$default_value" ]; then
        read -p "$(echo -e "${BLUE}?${NC} $prompt_text [$default_value]: ")" result
        echo "${result:-$default_value}"
    else
        read -p "$(echo -e "${BLUE}?${NC} $prompt_text: ")" result
        echo "$result"
    fi
}

# Prompt for yes/no confirmation
prompt_yes_no() {
    local prompt_text="$1"
    local default="${2:-y}"
    local result

    if [ "$default" = "y" ]; then
        read -p "$(echo -e "${BLUE}?${NC} $prompt_text [Y/n]: ")" result
        result="${result:-y}"
    else
        read -p "$(echo -e "${BLUE}?${NC} $prompt_text [y/N]: ")" result
        result="${result:-n}"
    fi

    [[ "$result" =~ ^[Yy] ]]
}

# Get or prompt for git repository URL
get_git_repo_url() {
    local detected_repo

    # First check if already set
    if [ -n "$GIT_REPO_URL" ]; then
        echo "$GIT_REPO_URL"
        return 0
    fi

    # Try to auto-detect
    detected_repo=$(detect_git_repo)

    if [ -n "$detected_repo" ]; then
        echo -e "${GREEN}✓${NC} Detected git repository: $detected_repo"
        if prompt_yes_no "Use this repository?" "y"; then
            GIT_REPO_URL="$detected_repo"
            echo "$GIT_REPO_URL"
            return 0
        fi
    fi

    # Prompt user
    GIT_REPO_URL=$(prompt_with_default "Enter git repository URL" "")

    while [ -z "$GIT_REPO_URL" ]; do
        echo -e "${RED}✗${NC} Git repository URL is required"
        GIT_REPO_URL=$(prompt_with_default "Enter git repository URL" "")
    done

    echo "$GIT_REPO_URL"
}

# Get or prompt for git branch
get_git_branch() {
    local detected_branch

    # First check if already set
    if [ -n "$GIT_BRANCH" ]; then
        echo "$GIT_BRANCH"
        return 0
    fi

    # Try to auto-detect
    detected_branch=$(detect_git_branch)

    if [ -n "$detected_branch" ]; then
        GIT_BRANCH=$(prompt_with_default "Git branch" "$detected_branch")
    else
        GIT_BRANCH=$(prompt_with_default "Git branch" "main")
    fi

    echo "$GIT_BRANCH"
}

# Get or prompt for clone directory
get_clone_dir() {
    local default_dir="/workspace"

    # First check if already set
    if [ -n "$GIT_CLONE_DIR" ]; then
        echo "$GIT_CLONE_DIR"
        return 0
    fi

    GIT_CLONE_DIR=$(prompt_with_default "Clone directory in container" "$default_dir")
    echo "$GIT_CLONE_DIR"
}

# Initialize configuration with auto-detection and prompts
init_config() {
    local force_reconfigure="${1:-false}"

    echo -e "${BLUE}━━━ Claude Code Configuration ━━━${NC}\n"

    # Load existing config unless forcing reconfiguration
    if [ "$force_reconfigure" != "true" ] && load_config; then
        echo -e "${GREEN}✓${NC} Loaded existing configuration from $(get_config_file)\n"
        echo "Current settings:"
        echo "  Repository: $GIT_REPO_URL"
        echo "  Branch: $GIT_BRANCH"
        echo "  Clone directory: $GIT_CLONE_DIR"
        echo ""

        if ! prompt_yes_no "Use these settings?" "y"; then
            force_reconfigure="true"
        else
            return 0
        fi
    fi

    # Get configuration values
    GIT_REPO_URL=$(get_git_repo_url)
    GIT_BRANCH=$(get_git_branch)
    GIT_CLONE_DIR=$(get_clone_dir)

    # Optional: GitHub token
    if [ -z "$GITHUB_TOKEN" ]; then
        echo ""
        echo -e "${YELLOW}Optional:${NC} GitHub token for private repositories and PR creation"
        if prompt_yes_no "Do you want to set a GitHub token?" "n"; then
            GITHUB_TOKEN=$(prompt_with_default "GitHub token (will be stored in config)" "")
        fi
    fi

    # Save configuration
    echo ""
    save_config

    # Add to .gitignore
    if [ -f ".gitignore" ]; then
        if ! grep -q "^\.claude-code/" .gitignore 2>/dev/null; then
            echo "" >> .gitignore
            echo "# Claude Code" >> .gitignore
            echo ".claude-code/" >> .gitignore
            echo -e "${GREEN}✓${NC} Added .claude-code/ to .gitignore"
        fi
    fi

    echo ""
}

# Validate required configuration
validate_config() {
    local errors=0

    if [ -z "$GIT_REPO_URL" ]; then
        echo -e "${RED}✗${NC} GIT_REPO_URL is not set"
        errors=$((errors + 1))
    fi

    if [ -z "$GIT_BRANCH" ]; then
        echo -e "${RED}✗${NC} GIT_BRANCH is not set"
        errors=$((errors + 1))
    fi

    if [ $errors -gt 0 ]; then
        echo -e "\n${YELLOW}Run 'cc-init' to configure this project${NC}"
        return 1
    fi

    return 0
}

# Display current configuration
show_config() {
    if load_config; then
        echo -e "${BLUE}━━━ Current Configuration ━━━${NC}\n"
        echo "Config file: $(get_config_file)"
        echo ""
        echo "Settings:"
        echo "  GIT_REPO_URL: $GIT_REPO_URL"
        echo "  GIT_BRANCH: $GIT_BRANCH"
        echo "  GIT_CLONE_DIR: ${GIT_CLONE_DIR:-/workspace}"
        echo "  CLAUDE_SKIP_PERMISSIONS: ${CLAUDE_SKIP_PERMISSIONS:-false}"
        echo "  GITHUB_TOKEN: ${GITHUB_TOKEN:+<set>}"
        [ -z "$GITHUB_TOKEN" ] && echo "  GITHUB_TOKEN: <not set>"
    else
        echo -e "${YELLOW}⚠${NC} No configuration found in current directory"
        echo -e "Run ${GREEN}cc-init${NC} to configure this project"
        return 1
    fi
}

# Generate instance name from project directory
get_instance_name() {
    local custom_name="$1"

    if [ -n "$custom_name" ]; then
        echo "$custom_name"
    else
        # Use directory name as instance name
        detect_project_name | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]-_'
    fi
}
