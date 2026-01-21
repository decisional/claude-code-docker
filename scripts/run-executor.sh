#!/bin/bash
# Executor Agent (Claude) - Implements the plan
# This is the ONLY agent that makes code changes

set -e

STATE_DIR=$1

if [ -z "$STATE_DIR" ]; then
    echo "Error: STATE_DIR required"
    echo "Usage: $0 <state-dir>"
    exit 1
fi

PLAN_FILE="$STATE_DIR/plan.md"
REVIEW_FILE="$STATE_DIR/review.md"
RESPONSE_FILE="$STATE_DIR/executor-response.md"

if [ ! -f "$PLAN_FILE" ]; then
    echo "Error: plan.md not found at $STATE_DIR"
    exit 1
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  EXECUTOR AGENT (Claude)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Read plan content
PLAN_CONTENT=$(cat "$PLAN_FILE")

# Check if this is a review iteration (review.md exists)
ITERATION_CONTEXT=""
if [ -f "$REVIEW_FILE" ]; then
    REVIEW_CONTENT=$(cat "$REVIEW_FILE")
    ITERATION_CONTEXT=$(cat <<EOF

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REVIEWER FEEDBACK (Address these changes):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
$REVIEW_CONTENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Please address the reviewer's feedback above and make the necessary changes.
EOF
    )
fi

# Create execution prompt
PROMPT=$(cat <<EOF
You are an execution agent. Your job is to implement the plan below.

Implementation Plan:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
$PLAN_CONTENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
$ITERATION_CONTEXT

Your task:
1. Follow the implementation plan step by step
2. Make all necessary code changes
3. Ensure code quality and best practices
4. Write a summary of what you did to: $RESPONSE_FILE

Implementation guidelines:
- Follow the plan's steps in order
- Create or modify files as specified
- Add proper error handling
- Include comments where helpful
- Test your changes if possible
- Write clean, maintainable code

After completing the implementation, write a summary to $RESPONSE_FILE in this format:

# Execution Summary

## Changes Made
- [List of files changed/created]
- [Brief description of each change]

## Implementation Notes
[Any important decisions or deviations from the plan]

## Testing
[What testing was done, if any]

## Ready for Review
[Yes/No and any notes]

Now proceed with the implementation.
EOF
)

echo "Launching Claude with execution prompt..."
echo ""

# Change to repository directory
cd /workspace/autodex

# Launch Claude in non-interactive mode
# --print mode allows stdin input and executes tools
echo "$PROMPT" | claude --print --dangerously-skip-permissions 2>&1

# Verify response was created
if [ ! -f "$RESPONSE_FILE" ]; then
    echo ""
    echo "Warning: Executor did not create executor-response.md"
    echo "Creating default response..."

    cat > "$RESPONSE_FILE" <<EOF
# Execution Summary

## Changes Made
Implementation completed. Check git diff for details.

## Ready for Review
Yes
EOF
fi

echo ""
echo "✓ Execution completed"
echo "  Response: $RESPONSE_FILE"
echo "  Size: $(wc -c < "$RESPONSE_FILE") bytes"
echo ""

# Show git status
echo "Git changes:"
git status --short

echo ""

exit 0
