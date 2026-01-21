#!/bin/bash
# Mark PR as ready for review after approval

set -e

STATE_DIR=$1

if [ -z "$STATE_DIR" ]; then
    echo "Error: STATE_DIR required"
    echo "Usage: $0 <state-dir>"
    exit 1
fi

TICKET_ID=$(basename "$STATE_DIR")
BRANCH_NAME="workflow-$(echo $TICKET_ID | tr '[:upper:]' '[:lower:]')"

# Change to repository directory
cd /workspace/autodex

echo "Marking PR as ready for review..."

# Check if gh CLI is available
if ! command -v gh &> /dev/null; then
    echo "Warning: gh CLI not available"
    exit 1
fi

if ! gh auth status &> /dev/null; then
    echo "Warning: gh CLI not authenticated"
    exit 1
fi

# Mark PR as ready for review
gh pr ready "$BRANCH_NAME" 2>&1 || {
    echo "Note: Could not mark PR as ready (may already be ready or not exist)"
    exit 0
}

echo "✓ PR marked as ready for review"
exit 0
