# Interactive Mode - Live Chat with Agents

## Overview

In addition to the async file-based approach, you can **jump into the terminal** and chat directly with the agent for complex discussions.

## Two Modes of Interaction

### Mode 1: Async Response (Simple)

Best for straightforward questions with clear answers.

```bash
# Agent blocks with a question
$ ./workflow list --blocked
ID         TICKET    STATE              QUESTION
wf_abc123  DEC-124   execution_blocked  Which database?

# You respond asynchronously
$ ./workflow respond wf_abc123 -r "PostgreSQL"

# Agent continues automatically
```

### Mode 2: Interactive Session (Complex)

Best for:
- Complex discussions needing back-and-forth
- Providing detailed context or explanation
- Exploring options together
- Debugging issues with the agent

```bash
# Agent is blocked (or even if not blocked, just running)
$ ./workflow interact wf_abc123

# Opens interactive Claude/Codex session
# You can chat live with the agent!
```

## How Interactive Mode Works

### Starting Interactive Session

```bash
$ ./workflow interact wf_abc123

Workflow: wf_abc123
Ticket: DEC-124 - Add user preferences
State: execution_blocked
Phase: executor
Agent: claude

============================================================
🎯 INTERACTIVE MODE
============================================================
Opening interactive session with claude...

Context: You are helping with workflow wf_abc123 for Linear
ticket DEC-124. The workflow is currently blocked on this...

You can now chat directly with the agent.
When done, type 'exit' or press Ctrl+D to return.
============================================================

# Claude session opens in the container...
```

### What Happens Behind the Scenes

```bash
# Under the hood, this runs:
docker exec -it <container_id> claude "<context_prompt>"

# Where context_prompt includes:
# - Workflow ID and ticket info
# - Current blocking question (if any)
# - File locations (/workspace/linear-ticket.md, /workspace/plan.md)
# - Instructions to help you formulate an answer
```

### Example Interactive Session

```
============================================================
🎯 INTERACTIVE MODE
============================================================
Opening interactive session with claude...

You can now chat directly with the agent.
When done, type 'exit' or press Ctrl+D to return.
============================================================

Claude: I'm here to help with workflow wf_abc123 for ticket DEC-124.

The workflow is currently blocked on this question:
"Which database should we use for storing user preferences?"
Options: PostgreSQL, MySQL, MongoDB

How can I help you decide?

You: What does the existing codebase use?

Claude: Let me check... Reading the codebase structure...

Based on my analysis:
- The main application uses PostgreSQL (src/database/postgres.ts)
- There's existing connection pooling for PostgreSQL
- User data is already in PostgreSQL

For consistency, I'd recommend PostgreSQL. Would you like me to proceed with that?

You: Yes, but I want to use a separate table, not add columns to the existing users table

Claude: Good call! I'll create a new `user_preferences` table with:
- id (primary key)
- user_id (foreign key to users.id)
- key (preference name)
- value (preference value)
- created_at, updated_at

Should I proceed with this schema?

You: Perfect. One more thing - add an index on user_id for faster lookups

Claude: Excellent idea! I'll add:
- Index on user_id for fast lookups
- Unique constraint on (user_id, key) to prevent duplicates

Is that what you had in mind?

You: Yes, go ahead

Claude: Great! To summarize the decision:
- Database: PostgreSQL
- New table: user_preferences
- Schema: id, user_id, key, value, timestamps
- Index on user_id
- Unique constraint on (user_id, key)

I'll use this approach to continue the implementation.

You: exit

============================================================
Interactive session ended.
============================================================

The workflow is still blocked.
Question: Which database should we use for storing user preferences?

Did you reach a decision? (y/n): y
Enter the decision/response: PostgreSQL with new user_preferences table (id, user_id, key, value, timestamps). Index on user_id, unique constraint on (user_id, key)
✓ Response saved
  Workflow will resume automatically
```

### After Interactive Session

The orchestrator:
1. Asks if you reached a decision
2. If yes, prompts you to enter the response
3. Saves it to `.workflow-resume.json`
4. Agent continues automatically

OR you can exit without saving and respond later:

```bash
Did you reach a decision? (y/n): n
No response saved. Workflow remains blocked.
You can respond later with: ./workflow respond wf_abc123
```

## Interactive Commands

### 1. `./workflow interact <workflow_id>`

Chat with the agent (Claude or Codex) in the container.

**Options:**
- `--executor` - Interact with executor instead of planner

**When to use:**
- Workflow is blocked and you want to discuss options
- You want to provide complex context
- You need to debug something with the agent
- You want to guide the agent through a tricky decision

**Example:**
```bash
# Interact with current phase (planner or executor)
./workflow interact wf_abc123

# Specifically interact with executor
./workflow interact wf_abc123 --executor
```

### 2. `./workflow shell <workflow_id>`

Open a bash shell in the container for manual inspection.

**Options:**
- `--executor` - Open shell in executor instead of planner
- `--shell <shell>` - Use different shell (default: /bin/bash)

**When to use:**
- Inspect files manually
- Debug container issues
- Run custom commands
- Check git status, logs, etc.

**Example:**
```bash
# Open bash in container
./workflow shell wf_abc123

# Inside the shell:
$ ls /workspace
linear-ticket.md  plan.md  attachments/  .workflow-status.json

$ cat /workspace/plan.md
$ git status
$ exit

============================================================
Shell session ended.
============================================================
```

## Use Cases

### Use Case 1: Complex Technical Decision

```bash
# Agent asks: "Should we use REST or GraphQL?"
$ ./workflow interact wf_abc123

You: Let's discuss the tradeoffs. What does the existing API use?

Claude: The existing API is REST-based. All endpoints in /api/* use Express with REST conventions.

You: How complex is the data model for this feature?

Claude: It's fairly simple - just user preferences with key-value pairs. No complex nested relationships.

You: Then let's stick with REST for consistency. How would you structure the endpoints?

Claude: I'd suggest:
- GET /api/preferences - list all for current user
- GET /api/preferences/:key - get specific preference
- PUT /api/preferences/:key - set preference
- DELETE /api/preferences/:key - remove preference

You: Perfect, go with that

Claude: Noted! I'll implement REST endpoints with that structure.

You: exit

Did you reach a decision? (y/n): y
Enter the decision/response: Use REST API with endpoints: GET/PUT/DELETE /api/preferences/:key
✓ Response saved
```

### Use Case 2: Providing Context

```bash
# Agent asks: "Which authentication method?"
$ ./workflow interact wf_abc123

You: Before we decide, let me give you context. This feature will be used by:
1. Internal admin users (already authenticated via SSO)
2. External API clients (need API keys)
3. Mobile app (uses JWT tokens)

Claude: Thank you for the context! Given those three use cases, I'd recommend:
1. For admin users: reuse existing SSO session
2. For API clients: implement API key authentication
3. For mobile app: support JWT bearer tokens

Should I implement support for all three methods?

You: Yes, and make sure they all use the same underlying permission system

Claude: Excellent point! I'll:
1. Create a unified auth middleware
2. Support all three methods (SSO, API key, JWT)
3. All methods map to same User object
4. Shared permission checking logic

Sound good?

You: Perfect!

You: exit
```

### Use Case 3: Debugging with Agent

```bash
# Workflow is stuck, not progressing
$ ./workflow interact wf_abc123

You: You seem stuck. What's the current status?

Claude: I'm trying to run the tests but they're failing. Let me show you:

[Claude runs test command and shows output]

You: I see the issue - you're missing an environment variable. Can you read .env.example?

Claude: [Reads .env.example]

Ah yes! I need DATABASE_URL. Should I add it to .env?

You: Yes, use: DATABASE_URL=postgresql://localhost/test_db

Claude: Done! Running tests again... All passing now!

You: Great, continue with the implementation

You: exit
```

### Use Case 4: Manual Inspection

```bash
# You want to see what the agent has done so far
$ ./workflow shell wf_abc123

============================================================
🐚 SHELL MODE
============================================================

$ cd /workspace
$ git status
On branch feature/DEC-124-add-user-preferences
Changes not staged for commit:
  modified:   src/routes/api.ts
  modified:   src/database/schema.sql

$ git diff src/routes/api.ts
[Shows changes agent made]

$ cat plan.md
[Review the plan]

$ ls attachments/
mockup.png  design-spec.pdf

$ exit

============================================================
Shell session ended.
============================================================
```

## Comparison: Async vs Interactive

| Aspect | Async Response | Interactive Mode |
|--------|----------------|------------------|
| **Speed** | Fast, one command | Slower, full chat session |
| **Use Case** | Simple questions | Complex discussions |
| **Interaction** | One-way | Back-and-forth dialogue |
| **Context** | Limited | Rich, can explain details |
| **Best For** | Clear decisions | Exploring options |
| **Example** | "Use PostgreSQL" | Discussing database schema design |

## Tips

1. **Use Interactive for Complex Issues**: If you find yourself wanting to explain something in detail, use interactive mode

2. **Shell for Debugging**: Use shell mode to inspect files, check git status, or manually verify changes

3. **Async for Speed**: When you know the answer, use async `respond` command for efficiency

4. **Multiple Sessions**: You can open interactive sessions even when workflow isn't blocked - useful for guidance

5. **Save Your Decision**: After interactive discussion, save the final decision so the agent can continue

## Architecture

```
┌──────────────────────────────────────┐
│  You (on your machine)               │
│                                      │
│  $ ./workflow interact wf_abc123     │
└──────────────┬───────────────────────┘
               │
               │ Runs docker exec -it
               ↓
┌──────────────────────────────────────┐
│  Docker Container                    │
│  ┌────────────────────────────────┐  │
│  │  Claude/Codex Session          │  │
│  │  (with context loaded)         │  │
│  │                                │  │
│  │  You ←→ Agent                  │  │
│  │  (live chat)                   │  │
│  └────────────────────────────────┘  │
│                                      │
│  /workspace/                         │
│  ├── linear-ticket.md                │
│  ├── plan.md                         │
│  └── attachments/                    │
└──────────────────────────────────────┘
```

## Summary

**Interactive mode** gives you the flexibility to:
- ✅ Jump into a live chat session with the agent
- ✅ Have complex technical discussions
- ✅ Provide detailed context and guidance
- ✅ Debug issues together
- ✅ Make collaborative decisions

**While still supporting**:
- ✅ Async file-based responses for simple cases
- ✅ Fully automated workflows when no input needed
- ✅ Both modes working together seamlessly

Best of both worlds! 🚀
