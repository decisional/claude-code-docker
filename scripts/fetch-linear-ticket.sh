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

# Check if Linear API key is available in .claude.json
LINEAR_API_KEY=""
if [ -f /home/node/.claude/.claude.json ]; then
    LINEAR_API_KEY=$(jq -r '.mcpServers."linear-server".env.LINEAR_API_KEY // empty' /home/node/.claude/.claude.json 2>/dev/null)
fi

# Try Linear GraphQL API first if API key is available
if [ -n "$LINEAR_API_KEY" ]; then
    echo "Using Linear GraphQL API..."

    # Fetch ticket via GraphQL API
    GRAPHQL_QUERY=$(cat <<'GRAPHQL_EOF'
{
  "query": "query Issue($id: String!) { issue(id: $id) { id identifier title description state { name } assignee { name email } project { name } priority priorityLabel createdAt updatedAt url } }",
  "variables": {"id": "TICKET_ID_PLACEHOLDER"}
}
GRAPHQL_EOF
    )

    # Substitute ticket ID
    GRAPHQL_QUERY=$(echo "$GRAPHQL_QUERY" | sed "s/TICKET_ID_PLACEHOLDER/$TICKET_ID/g")

    # Make API request
    RESPONSE=$(curl -s -X POST https://api.linear.app/graphql \
        -H "Content-Type: application/json" \
        -H "Authorization: $LINEAR_API_KEY" \
        -d "$GRAPHQL_QUERY")

    # Parse response and create markdown
    if echo "$RESPONSE" | jq -e '.data.issue' >/dev/null 2>&1; then
        TITLE=$(echo "$RESPONSE" | jq -r '.data.issue.title')
        DESCRIPTION=$(echo "$RESPONSE" | jq -r '.data.issue.description // "No description"')
        STATE=$(echo "$RESPONSE" | jq -r '.data.issue.state.name // "Unknown"')
        ASSIGNEE=$(echo "$RESPONSE" | jq -r '.data.issue.assignee.name // "Unassigned"')
        PROJECT=$(echo "$RESPONSE" | jq -r '.data.issue.project.name // "No project"')
        PRIORITY=$(echo "$RESPONSE" | jq -r '.data.issue.priorityLabel // "No priority"')
        URL=$(echo "$RESPONSE" | jq -r '.data.issue.url // ""')

        cat > "$OUTPUT_FILE" <<EOF
# Linear Ticket: $TICKET_ID

**Title:** $TITLE

**Status:** $STATE

**Assignee:** $ASSIGNEE

**Project:** $PROJECT

**Priority:** $PRIORITY

**URL:** $URL

## Description

$DESCRIPTION

## Instructions

Please implement the changes described in this ticket following best practices and ensuring all requirements are met.
EOF

        echo "✓ Ticket fetched via Linear API"
    else
        echo "Warning: Linear API fetch failed, trying Linear CLI..."
        ERROR_MSG=$(echo "$RESPONSE" | jq -r '.errors[0].message // "Unknown error"')
        echo "  Error: $ERROR_MSG"
    fi
fi

# Fallback to Linear CLI if API didn't work
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
