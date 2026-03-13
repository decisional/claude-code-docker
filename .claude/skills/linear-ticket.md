---
name: linear
description: Read and work on a Linear ticket. Fetches ticket details, comments, and related context from Linear's API.
user_invocable: true
---

# Linear Ticket Skill

When invoked, read the Linear ticket and start working on it.

## How to read a Linear ticket

The Linear API key is available at `/home/node/.linear-api-key`. Use it to query the Linear GraphQL API.

### Reading a ticket by identifier (e.g., AUT-123)

```bash
LINEAR_API_KEY=$(cat /home/node/.linear-api-key 2>/dev/null)
if [ -z "$LINEAR_API_KEY" ]; then
  echo "No Linear API key found"
  exit 1
fi

curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query": "query($id: String!) { issueVcsBranchSearch(branchName: $id) { id identifier title description url state { name } labels { nodes { name } } comments { nodes { body user { name } createdAt } } } }", "variables": {"id": "TICKET_ID"}}'
```

### Reading a ticket by searching identifier

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query": "query($filter: IssueFilter!) { issues(filter: $filter, first: 1) { nodes { id identifier title description url state { name } labels { nodes { name } } comments(first: 20) { nodes { body user { name } createdAt } } } } }", "variables": {"filter": {"identifier": {"eq": "TICKET_ID"}}}}'
```

## Workflow

When asked to pick up a Linear ticket:

1. Read the ticket details from the message or fetch them from Linear using the API key
2. Understand the ticket title, description, and all comments
3. Create a new git branch named after the ticket identifier (e.g., `AUT-123-short-description`)
4. Implement the changes described in the ticket
5. Follow the project's CLAUDE.md instructions for code quality checks
6. Commit, push, and create a PR with a detailed description that references the Linear ticket
7. The PR description should link back to the Linear ticket URL
