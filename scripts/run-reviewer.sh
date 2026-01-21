#!/bin/bash
# Reviewer Agent (Codex) - Reviews implementation and provides feedback
# This agent is READ-ONLY and should not make any code changes

set -e

STATE_DIR=$1

if [ -z "$STATE_DIR" ]; then
    echo "Error: STATE_DIR required"
    echo "Usage: $0 <state-dir>"
    exit 1
fi

PLAN_FILE="$STATE_DIR/plan.md"
RESPONSE_FILE="$STATE_DIR/executor-response.md"
REVIEW_FILE="$STATE_DIR/review.md"

if [ ! -f "$RESPONSE_FILE" ]; then
    echo "Error: executor-response.md not found at $STATE_DIR"
    exit 1
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  REVIEWER AGENT (Codex)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Read plan and executor response
PLAN_CONTENT=$(cat "$PLAN_FILE")
RESPONSE_CONTENT=$(cat "$RESPONSE_FILE")

# Get git diff
echo "Generating git diff..."
GIT_DIFF=$(git diff HEAD 2>/dev/null || echo "No changes detected")

# Create review prompt
PROMPT=$(cat <<EOF
You are a code review agent. Your job is to review the implementation and provide feedback.

IMPORTANT CONSTRAINTS:
- DO NOT make any code changes
- DO NOT edit any files
- Your ONLY output should be a review in markdown format

Original Plan:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
$PLAN_CONTENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Executor's Response:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
$RESPONSE_CONTENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Git Diff:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
$GIT_DIFF
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Your task:
1. Review the implementation against the original plan
2. Check code quality, best practices, and correctness
3. Verify all plan steps were completed
4. Look for potential bugs or issues
5. Provide clear, actionable feedback

Your review MUST start with EXACTLY one of these keywords on the first line:
- APPROVE: if changes are good and ready for PR
- REQUEST_CHANGES: if changes need improvement

Write your review to: $REVIEW_FILE

Review format:

APPROVE
or
REQUEST_CHANGES

# Code Review

## Summary
[Overall assessment]

## Checklist
- [x] Plan followed correctly
- [ ] Code quality is good
- [ ] No obvious bugs
- [ ] Testing is adequate

## Detailed Feedback
[If REQUEST_CHANGES, provide specific issues to fix]
[If APPROVE, provide any optional suggestions]

## Files Reviewed
- file1.py - [comments]
- file2.go - [comments]

Remember:
- First line MUST be either "APPROVE" or "REQUEST_CHANGES"
- DO NOT make any code changes yourself
- Provide specific, actionable feedback
- Be thorough but concise
EOF
)

echo "Launching Codex with review prompt..."
echo ""

# Change to repository directory (Codex requires being in a git repo)
cd /workspace/autodex

# Launch Codex in non-interactive mode
# exec mode accepts stdin and runs non-interactively
# Use --dangerously-bypass-approvals-and-sandbox since we're in a trusted container
echo "$PROMPT" | codex exec --dangerously-bypass-approvals-and-sandbox 2>&1

# Verify review was created
if [ ! -f "$REVIEW_FILE" ]; then
    echo ""
    echo "Error: Reviewer did not create review.md"
    exit 1
fi

# Verify review starts with decision keyword
FIRST_LINE=$(head -n 1 "$REVIEW_FILE" | tr -d '\n\r' | tr '[:upper:]' '[:lower:]')

if ! echo "$FIRST_LINE" | grep -qE "^(approve|request_changes)"; then
    echo ""
    echo "Error: review.md must start with APPROVE or REQUEST_CHANGES"
    echo "First line found: $FIRST_LINE"
    exit 1
fi

echo ""
echo "✓ Review completed"
echo "  Output: $REVIEW_FILE"
echo "  Size: $(wc -c < "$REVIEW_FILE") bytes"
echo "  Decision: $FIRST_LINE"
echo ""

exit 0
