#!/bin/bash
# Planner Agent (Codex) - Creates detailed implementation plan
# This agent is READ-ONLY and should not make any code changes

set -e

STATE_DIR=$1

if [ -z "$STATE_DIR" ]; then
    echo "Error: STATE_DIR required"
    echo "Usage: $0 <state-dir>"
    exit 1
fi

TICKET_FILE="$STATE_DIR/linear-ticket.md"
PLAN_FILE="$STATE_DIR/plan.md"

if [ ! -f "$TICKET_FILE" ]; then
    echo "Error: linear-ticket.md not found at $STATE_DIR"
    exit 1
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  PLANNER AGENT (Codex)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Read ticket content
TICKET_CONTENT=$(cat "$TICKET_FILE")

# Create planning prompt
PROMPT=$(cat <<EOF
You are a planning agent. Your job is to analyze the Linear ticket below and create a detailed implementation plan.

IMPORTANT CONSTRAINTS:
- DO NOT make any code changes
- DO NOT edit any files
- DO NOT run any commands that modify files
- Your ONLY output should be a markdown plan

Linear Ticket:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
$TICKET_CONTENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Your task:
1. Analyze the ticket requirements thoroughly
2. Explore the codebase to understand the current structure
3. Create a detailed step-by-step implementation plan

Your plan should include:
- Overview of what needs to be done
- Specific files that need to be created/modified
- Implementation steps in order
- Any dependencies or considerations
- Testing approach

Output your plan ONLY to the file: $PLAN_FILE

The plan should be in markdown format with clear sections:
# Implementation Plan

## Overview
[High-level summary]

## Files to Modify/Create
- file1.py - [what changes]
- file2.go - [what changes]

## Implementation Steps
1. Step 1
2. Step 2
...

## Testing Strategy
[How to test the changes]

## Considerations
[Any edge cases, dependencies, etc.]

Remember: DO NOT make any code changes. Only create the plan.md file.
EOF
)

echo "Launching Codex with planning prompt..."
echo ""

# Change to repository directory (Codex requires being in a git repo)
cd /workspace/autodex

# Run Codex in non-interactive mode with the prompt
# Codex exec accepts stdin and runs non-interactively
# Use --dangerously-bypass-approvals-and-sandbox since we're in a trusted container
echo "$PROMPT" | codex exec --dangerously-bypass-approvals-and-sandbox 2>&1

# Verify plan was created
if [ ! -f "$PLAN_FILE" ]; then
    echo ""
    echo "Error: Planner did not create plan.md"
    exit 1
fi

echo ""
echo "✓ Plan created successfully"
echo "  Output: $PLAN_FILE"
echo "  Size: $(wc -c < "$PLAN_FILE") bytes"
echo ""

exit 0
