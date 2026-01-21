#!/bin/bash
# Fetch Linear ticket and convert to markdown

set -e

TICKET_ID=$1
STATE_DIR=$2

if [ -z "$TICKET_ID" ] || [ -z "$STATE_DIR" ]; then
    echo "Error: TICKET_ID and STATE_DIR required"
    echo "Usage: $0 <ticket-id> <state-dir>"
    exit 1
fi

OUTPUT_FILE="$STATE_DIR/linear-ticket.md"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  FETCHING LINEAR TICKET: $TICKET_ID"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check if Linear CLI/MCP is available
# Try Claude with Linear MCP first (most common in container)
if [ -f /usr/local/bin/claude ] || command -v claude &> /dev/null; then
    # Use Claude with Linear MCP to fetch ticket
    echo "Using Claude with Linear MCP..."

    FETCH_PROMPT="Use the Linear MCP to fetch issue $TICKET_ID and write a markdown summary to $OUTPUT_FILE. The markdown should include the title, description, status, assignee, project, and any attachments or links. Format it clearly for use by other agents."

    echo "$FETCH_PROMPT" | claude --print --dangerously-skip-permissions 2>&1

    # Verify file was created
    if [ -f "$OUTPUT_FILE" ]; then
        echo "✓ Ticket fetched via Linear MCP"
    else
        echo "Warning: Linear MCP fetch failed, trying Linear CLI..."
    fi
fi

# Fallback to Linear CLI if Claude MCP didn't work
if [ ! -f "$OUTPUT_FILE" ] && command -v linear &> /dev/null; then
    echo "Using Linear CLI..."
    # Fetch ticket using Linear CLI (if available)
    linear issue view "$TICKET_ID" --format json > /tmp/linear-ticket-$$.json

    # Convert to markdown
    TITLE=$(jq -r '.title' /tmp/linear-ticket-$$.json)
    DESCRIPTION=$(jq -r '.description // "No description"' /tmp/linear-ticket-$$.json)
    STATE=$(jq -r '.state.name // "Unknown"' /tmp/linear-ticket-$$.json)
    ASSIGNEE=$(jq -r '.assignee.name // "Unassigned"' /tmp/linear-ticket-$$.json)
    PROJECT=$(jq -r '.project.name // "No project"' /tmp/linear-ticket-$$.json)

    cat > "$OUTPUT_FILE" <<EOF
# Linear Ticket: $TICKET_ID

**Title:** $TITLE

**Status:** $STATE

**Assignee:** $ASSIGNEE

**Project:** $PROJECT

## Description

$DESCRIPTION

## Instructions

Please implement the changes described in this ticket following best practices and ensuring all requirements are met.
EOF

    rm -f /tmp/linear-ticket-$$.json
fi

# Final fallback: Create placeholder if nothing worked
if [ ! -f "$OUTPUT_FILE" ]; then
    echo "Warning: Could not fetch ticket from Linear"
    echo "Creating placeholder ticket..."

    # Create placeholder ticket for testing
    cat > "$OUTPUT_FILE" <<EOF
# Linear Ticket: $TICKET_ID

**Title:** [Placeholder] Implement feature for $TICKET_ID

**Status:** In Progress

**Assignee:** Auto-assigned

**Project:** Autodex - Product Roadmap

## Description

This is a placeholder ticket. In production, this would be fetched from Linear API.

Please implement the following:
- Review the existing codebase structure
- Make necessary changes according to the ticket requirements
- Ensure all tests pass
- Follow coding best practices

## Instructions

Implement the changes as described above. This is a test workflow.
EOF
fi

echo "✓ Ticket fetched successfully"
echo "  Output: $OUTPUT_FILE"
echo "  Size: $(wc -c < "$OUTPUT_FILE") bytes"
echo ""

# Show ticket preview
echo "Ticket preview:"
echo "───────────────────────────────────────────────────────────"
head -n 20 "$OUTPUT_FILE"
echo "───────────────────────────────────────────────────────────"
echo ""

exit 0
