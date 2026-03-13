---
name: linear-ticket
description: Read and work on a Linear ticket. Fetches ticket details, comments, and related context from Linear's API.
user_invocable: true
---

# Linear Ticket Skill

When invoked, read the Linear ticket and start working on it.

## How to read a Linear ticket

The Linear API key is available at `/home/node/.linear-api-key`. Use it to query the Linear GraphQL API at `https://api.linear.app/graphql`.

### Fetch full ticket details by identifier (e.g., AUT-123)

```bash
LINEAR_API_KEY=$(cat /home/node/.linear-api-key 2>/dev/null)
if [ -z "$LINEAR_API_KEY" ]; then
  echo "No Linear API key found at /home/node/.linear-api-key"
  exit 1
fi

TICKET_ID="AUT-123"  # Replace with actual ticket identifier

curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d "$(cat <<QUERY
{
  "query": "query(\$filter: IssueFilter!) { issues(filter: \$filter, first: 1) { nodes { id identifier title description url priority priorityLabel state { name } assignee { name } labels { nodes { name } } project { name } attachments { nodes { title url } } comments(first: 50) { nodes { body user { name } createdAt } } } } }",
  "variables": { "filter": { "identifier": { "eq": "$TICKET_ID" } } }
}
QUERY
)"
```

## Workflow

When asked to pick up a Linear ticket:

1. Fetch the full ticket from Linear using the API key and the query above
2. Read and understand the title, description, all comments, and any attachments
3. Create a new git branch named after the ticket identifier (e.g., `AUT-123-short-description`)
4. Implement the changes described in the ticket
5. Follow the project's CLAUDE.md instructions for code quality checks
6. Commit, push, and create a PR with a detailed description that references the Linear ticket
7. The PR description should link back to the Linear ticket URL
