#!/bin/bash
# Script to update the Homebrew formula with release information
# Run this after creating a GitHub release

set -e

echo "🔄 Update Homebrew Formula"
echo "=========================="
echo ""

# Configuration
GITHUB_ORG="decisional"
MAIN_REPO="claude-code-docker"

# Get version from user
read -p "Version tag (e.g., v1.0.0): " VERSION

if [ -z "$VERSION" ]; then
    echo "❌ Version is required"
    exit 1
fi

# Remove 'v' prefix if present for version field
VERSION_NUMBER="${VERSION#v}"

# Construct URL
TARBALL_URL="https://github.com/$GITHUB_ORG/$MAIN_REPO/archive/refs/tags/$VERSION.tar.gz"

echo ""
echo "📥 Downloading tarball to calculate SHA256..."
echo "URL: $TARBALL_URL"
echo ""

# Download and calculate SHA256
SHA256=$(curl -sL "$TARBALL_URL" | shasum -a 256 | awk '{print $1}')

if [ -z "$SHA256" ]; then
    echo "❌ Failed to calculate SHA256. Make sure the release exists on GitHub."
    exit 1
fi

echo "✅ SHA256: $SHA256"
echo ""

# Update the formula file
FORMULA_FILE="formula/claude-code.rb"
TAP_FORMULA_FILE="../homebrew-claude-code/Formula/claude-code.rb"

echo "Updating formula files..."

# Function to update a formula file
update_formula() {
    local file=$1

    if [ ! -f "$file" ]; then
        echo "⚠️  File not found: $file"
        return 1
    fi

    # Update URL
    sed -i.bak "s|url \".*\"|url \"$TARBALL_URL\"|" "$file"

    # Update SHA256
    sed -i.bak "s|sha256 \".*\"|sha256 \"$SHA256\"|" "$file"

    # Update version
    sed -i.bak "s|version \".*\"|version \"$VERSION_NUMBER\"|" "$file"

    # Update homepage if needed
    sed -i.bak "s|homepage \".*\"|homepage \"https://github.com/$GITHUB_ORG/$MAIN_REPO\"|" "$file"

    # Remove backup file
    rm -f "$file.bak"

    echo "✅ Updated: $file"
    return 0
}

# Update main formula
if update_formula "$FORMULA_FILE"; then
    echo ""
    echo "Main formula updated."
fi

echo ""

# Update tap formula if it exists
if update_formula "$TAP_FORMULA_FILE"; then
    echo ""
    echo "📝 Tap formula updated. Don't forget to commit and push:"
    echo ""
    echo "  cd ../homebrew-claude-code"
    echo "  git add Formula/claude-code.rb"
    echo "  git commit -m \"Update formula to v$VERSION_NUMBER\""
    echo "  git push"
fi

echo ""
echo "✅ Formula update complete!"
echo ""
echo "Summary:"
echo "  Version: $VERSION_NUMBER"
echo "  URL: $TARBALL_URL"
echo "  SHA256: $SHA256"
echo ""
echo "Next steps:"
echo "1. Review the changes in formula/claude-code.rb"
echo "2. Test installation:"
echo "   brew uninstall claude-code (if already installed)"
echo "   brew install --build-from-source formula/claude-code.rb"
echo "   cc-setup"
echo "3. If tap exists, commit and push the tap formula"
echo ""
