#!/bin/bash
# Script to create a Homebrew tap repository
# This sets up the homebrew-claude-code tap for public distribution

set -e

echo "🍺 Creating Homebrew Tap for Claude Code"
echo "=========================================="
echo ""

# Configuration
TAP_NAME="homebrew-claude-code"
GITHUB_ORG="decisional"
MAIN_REPO="claude-code-docker"
VERSION="1.0.0"

echo "Configuration:"
echo "  Tap name: $TAP_NAME"
echo "  GitHub org: $GITHUB_ORG"
echo "  Main repo: $MAIN_REPO"
echo "  Version: $VERSION"
echo ""

# Check if tap directory already exists
if [ -d "../$TAP_NAME" ]; then
    echo "⚠️  Directory ../$TAP_NAME already exists"
    read -p "Delete and recreate? (y/N): " confirm
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
        rm -rf "../$TAP_NAME"
    else
        echo "Aborted"
        exit 1
    fi
fi

# Create tap directory
echo "1. Creating tap directory structure..."
mkdir -p "../$TAP_NAME/Formula"
cd "../$TAP_NAME"

# Copy formula
echo "2. Copying formula..."
cp "../llm-docker/formula/claude-code.rb" "Formula/"

# Create README
echo "3. Creating README..."
cat > README.md << 'EOF'
# Homebrew Tap for Claude Code

This is the official Homebrew tap for [Claude Code Docker](https://github.com/decisional/claude-code-docker).

## Installation

```bash
brew tap decisional/claude-code
brew install claude-code
```

## Setup

After installation, run the setup command:

```bash
cc-setup
```

This will:
1. Check Docker is installed and running
2. Extract Claude credentials from macOS Keychain
3. Build the Docker image

## Usage

```bash
# Navigate to your project
cd /path/to/your/project

# Initialize configuration (auto-detects git repo/branch)
cc-init

# Start Claude Code
cc-start
```

## Commands

- `cc-setup` - Initial setup (run once after install)
- `cc-init` - Initialize project configuration
- `cc-config` - View/edit configuration
- `cc-start` - Start/create instance
- `cc-exec` - Connect to existing instance
- `cc-shell` - Open shell in instance
- `cc-stop` - Stop instance
- `cc-rm` - Remove instance
- `cc-clean` - Remove all stopped instances
- `cc-list` - List all instances
- `cc-build` - Rebuild Docker image

## Requirements

- macOS
- Docker Desktop
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)

## Documentation

For full documentation, visit the [main repository](https://github.com/decisional/claude-code-docker).

## Issues

Report issues at https://github.com/decisional/claude-code-docker/issues
EOF

# Initialize git
echo "4. Initializing git repository..."
git init
git add .
git commit -m "Initial commit: Add claude-code formula v$VERSION

This tap provides easy installation of claude-code CLI tools for
managing isolated Claude Code Docker instances.

Features:
- Per-project configuration with auto-detection
- Interactive setup prompts
- System-wide command availability
- Homebrew-standard installation

Installation:
  brew tap $GITHUB_ORG/claude-code
  brew install claude-code
  cc-setup
"

echo ""
echo "✅ Tap repository created successfully!"
echo ""
echo "Next steps:"
echo ""
echo "1. Create the GitHub repository:"
echo "   https://github.com/new"
echo "   Repository name: $TAP_NAME"
echo "   Make it public"
echo ""
echo "2. Push the tap to GitHub:"
echo "   cd ../$TAP_NAME"
echo "   git remote add origin https://github.com/$GITHUB_ORG/$TAP_NAME.git"
echo "   git push -u origin main"
echo ""
echo "3. Create a release in the main repository:"
echo "   cd ../llm-docker"
echo "   git tag v$VERSION"
echo "   git push origin v$VERSION"
echo "   # Then create a release on GitHub from this tag"
echo ""
echo "4. Get the SHA256 hash:"
echo "   curl -L https://github.com/$GITHUB_ORG/$MAIN_REPO/archive/refs/tags/v$VERSION.tar.gz | shasum -a 256"
echo ""
echo "5. Update the formula with the SHA256 hash:"
echo "   Edit ../$TAP_NAME/Formula/claude-code.rb"
echo "   Update the sha256 field with the hash from step 4"
echo "   Commit and push the change"
echo ""
echo "6. Test installation:"
echo "   brew tap $GITHUB_ORG/claude-code"
echo "   brew install claude-code"
echo ""
echo "7. Announce it! 🎉"
echo ""
