#!/bin/bash
# Setup script for workflow orchestrator

set -e

echo "Setting up Workflow Orchestrator..."
echo "===================================="
echo ""

# Check Python version
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 is required but not found"
    exit 1
fi

PYTHON_VERSION=$(python3 --version | cut -d' ' -f2 | cut -d'.' -f1-2)
echo "✓ Found Python $PYTHON_VERSION"

# Install dependencies
echo ""
echo "Installing Python dependencies..."
pip3 install -r requirements.txt

echo ""
echo "✓ Dependencies installed"
echo ""

# Check for config
if [ ! -f "../config.yaml" ]; then
    echo "⚠ No config.yaml found"
    echo "  Copy config.example.yaml to ../config.yaml and fill in your values"
    echo ""
    echo "  Or set environment variables:"
    echo "    - LINEAR_API_KEY (required)"
    echo "    - GIT_REPO_URL (required)"
    echo ""
fi

# Create workflows directory
mkdir -p ../workflows

echo "✓ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Configure Linear API key and repo URL (see README.md)"
echo "2. Run: ./workflow start DEC-123"
echo ""
