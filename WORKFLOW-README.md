# Multi-Agent Autonomous Workflow System

## Overview

This system orchestrates multiple AI agents (Codex for planning/review, Claude for execution) to autonomously complete Linear tickets in a single container workflow.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   cc-workflow (Host)                        │
│  - Manages workflow lifecycle                               │
│  - Creates/resumes containers                               │
│  - Handles state persistence                                │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│         Container: workflow-{ticket-id}                     │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐ │
│  │       workflow-orchestrator.sh                        │ │
│  │  (State machine: INIT → PLANNING → EXECUTING →       │ │
│  │   REVIEWING → PR → COMPLETED)                         │ │
│  └───────┬───────────────────────────────────────────────┘ │
│          │                                                   │
│          ├─→ fetch-linear-ticket.sh (Linear API)            │
│          ├─→ run-planner.sh (Codex)                         │
│          ├─→ run-executor.sh (Claude)                       │
│          ├─→ run-reviewer.sh (Codex)                        │
│          └─→ create-pr.sh (Git + GitHub)                    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│        workflow-data/{ticket-id}/                           │
│  - workflow-state.json (current phase, iteration)           │
│  - linear-ticket.md (ticket details)                        │
│  - plan.md (planner output)                                 │
│  - executor-response.md (execution summary)                 │
│  - review.md (reviewer feedback)                            │
│  - agent-logs/ (detailed logs)                              │
└─────────────────────────────────────────────────────────────┘
```

## Components

### 1. cc-workflow (Main CLI)

```bash
./cc-workflow start <linear-ticket-id>    # Start new workflow
./cc-workflow resume <ticket-id>          # Resume paused workflow
./cc-workflow status <ticket-id>          # Show status
./cc-workflow list                        # List all workflows
./cc-workflow cleanup <ticket-id>         # Remove workflow
```

### 2. workflow-orchestrator.sh (State Machine)

Runs inside container and coordinates agents through phases:

- **INIT**: Fetch Linear ticket
- **PLANNING**: Codex creates implementation plan
- **EXECUTING**: Claude implements changes
- **REVIEWING**: Codex reviews changes
- **Iteration Loop**: If review requests changes, go back to executing
- **PR**: Create pull request
- **COMPLETED**: Done!

### 3. Agent Scripts

#### fetch-linear-ticket.sh
- Fetches Linear ticket via API/MCP
- Converts to markdown format
- Includes title, description, attachments

#### run-planner.sh (Codex)
- **READ-ONLY** agent
- Reads: linear-ticket.md
- Explores codebase
- Outputs: plan.md with step-by-step implementation

#### run-executor.sh (Claude)
- **ONLY agent that makes code changes**
- Reads: plan.md, review.md (if iteration)
- Implements changes
- Outputs: executor-response.md

#### run-reviewer.sh (Codex)
- **READ-ONLY** agent
- Reads: plan.md, executor-response.md, git diff
- Reviews code quality, correctness
- Outputs: review.md starting with APPROVE or REQUEST_CHANGES

#### create-pr.sh
- Creates branch (workflow-{ticket-id})
- Commits all changes
- Pushes to remote
- Creates PR with detailed description

## Workflow State

### workflow-state.json Schema

```json
{
  "ticket_id": "LIN-123",
  "phase": "EXECUTING",
  "status": "RUNNING",
  "iteration": 1,
  "max_iterations": 3,
  "created_at": "2025-01-20T10:00:00Z",
  "updated_at": "2025-01-20T10:15:00Z",
  "error": null,
  "container_name": "workflow-LIN-123"
}
```

### Phases
- `INIT` - Fetching ticket
- `PLANNING` - Creating plan
- `EXECUTING` - Implementing changes
- `REVIEWING` - Code review
- `PR` - Creating pull request
- `COMPLETED` - Done

### Status
- `RUNNING` - Active
- `PAUSED` - Waiting for manual intervention
- `COMPLETED` - Successfully finished
- `FAILED` - Unrecoverable error

## Communication Protocol

All inter-agent communication via markdown files:

### linear-ticket.md
```markdown
# Linear Ticket: LIN-123

**Title:** Add user authentication

**Status:** In Progress

## Description
[Ticket details...]
```

### plan.md
```markdown
# Implementation Plan

## Overview
[High-level summary]

## Files to Modify/Create
- auth.go - Add JWT middleware
- routes.go - Protect endpoints

## Implementation Steps
1. ...
```

### executor-response.md
```markdown
# Execution Summary

## Changes Made
- Created auth.go
- Modified routes.go

## Ready for Review
Yes
```

### review.md
```markdown
APPROVE

# Code Review

## Summary
Changes look good. JWT implementation is secure.

## Checklist
- [x] Plan followed correctly
- [x] Code quality is good
...
```

## Usage

### Starting a Workflow

```bash
# Start workflow for Linear ticket LIN-123
./cc-workflow start LIN-123
```

The system will:
1. Create container `workflow-LIN-123`
2. Fetch Linear ticket
3. Launch planner agent (Codex)
4. Launch executor agent (Claude)
5. Launch reviewer agent (Codex)
6. If approved → create PR
7. If changes requested → iterate

### Resuming After Pause

If the workflow pauses (due to errors), you can:

```bash
# Option 1: Resume workflow
./cc-workflow resume LIN-123

# Option 2: Jump into container to debug
docker exec -it claude-workflow-LIN-123-claude-code-1 bash
# ... inspect state, fix issues ...
# Then resume
./cc-workflow resume LIN-123
```

### Monitoring Status

```bash
# Check specific workflow
./cc-workflow status LIN-123

# List all workflows
./cc-workflow list
```

### Cleaning Up

```bash
# Remove workflow and container
./cc-workflow cleanup LIN-123
```

## Features

### ✅ Implemented

- [x] Multi-agent orchestration
- [x] State persistence (survives container restarts)
- [x] Auto-pause on errors
- [x] Resume capability
- [x] Iteration loop (executor ↔ reviewer)
- [x] Max iteration limit (prevents infinite loops)
- [x] Markdown-based communication
- [x] Read-only enforcement for planner/reviewer
- [x] Detailed logging
- [x] PR creation with full context
- [x] Git workflow (branching, committing, pushing)

### ✅ CLI Automation - SOLVED!

Both CLIs support non-interactive modes:

**Claude**: `claude --print --dangerously-skip-permissions`
- `--print` flag enables non-interactive output
- Accepts stdin via pipe or heredoc
- Executes tools when combined with `--dangerously-skip-permissions`
- Returns output and exits

**Codex**: `codex exec`
- Non-interactive execution mode
- Accepts stdin input
- Executes commands and tools
- Configured via `~/.codex/config.toml` for approval policy

**Usage**:
```bash
# Claude agent
echo "$PROMPT" | claude --print --dangerously-skip-permissions

# Codex agent
echo "$PROMPT" | codex exec
```

All agent scripts have been updated to use these modes for fully autonomous execution!

### ⚠️ Remaining Limitations

#### 1. Linear Integration

**Current**: fetch-linear-ticket.sh has three modes:
- Linear CLI (if available)
- Claude with Linear MCP (preferred)
- Placeholder (for testing)

**Production**: Needs Linear API token or MCP setup

### 🔄 Iteration Loop

```
┌──────────────┐
│  EXECUTING   │
└──────┬───────┘
       │
       ▼
┌──────────────┐      APPROVE      ┌──────────────┐
│  REVIEWING   │──────────────────→│     PR       │
└──────┬───────┘                    └──────────────┘
       │
       │ REQUEST_CHANGES
       │ (iteration < max_iterations)
       │
       └─────────→ back to EXECUTING

If iteration >= max_iterations: PAUSE for manual intervention
```

## Configuration

### Environment Variables

Set in `.env` file:

```bash
# Repository to clone
GIT_REPO_URL=git@github.com:decisional/autodex.git
GIT_BRANCH=main

# CLI permissions
CLAUDE_SKIP_PERMISSIONS=true
CODEX_YOLO=true

# GitHub for PR creation
GITHUB_TOKEN=ghp_...
```

### Iteration Limits

Edit `cc-workflow` script:
```json
"max_iterations": 3  // Default: 3 review cycles
```

## Troubleshooting

### Workflow Stuck in PAUSED

```bash
# Check status
./cc-workflow status LIN-123

# Check error
cat workflow-data/LIN-123/workflow-state.json | jq '.error'

# Check logs
ls workflow-data/LIN-123/agent-logs/

# Resume
./cc-workflow resume LIN-123
```

### Agent Failed

```bash
# Shell into container
docker exec -it claude-workflow-LIN-123-claude-code-1 bash

# Check agent logs
cat /workflow-state/LIN-123/agent-logs/*.log

# Check state
cat /workflow-state/LIN-123/workflow-state.json

# Manual fix, then resume from host
```

### No Changes Detected

Ensure:
- Executor agent created/modified files
- Git working directory is clean before starting
- Changes aren't gitignored

## Next Steps

### Immediate (Ready to Test!)

1. **Linear Integration**
   - Set up Linear MCP or API
   - Test ticket fetching
   - Add optional status updates

2. **End-to-End Testing**
   - Test with real Linear ticket
   - Verify all phases work
   - Test error handling and resume

### Future Enhancements

- [ ] Web dashboard for monitoring
- [ ] Parallel workflows (multiple tickets)
- [ ] Agent streaming output
- [ ] Custom models per agent (Haiku for review, etc.)
- [ ] Slack/email notifications
- [ ] Metrics tracking (time per phase, success rate)
- [ ] Template-based plans for common tasks

## Examples

### Example 1: Simple Feature Implementation

```bash
# Start workflow
./cc-workflow start LIN-456

# Output:
# Phase 1: Fetching Linear Ticket ✓
# Phase 2: Planning (Codex) ✓
# Phase 3: Executing (Claude) ✓
# Phase 4: Reviewing (Codex) - APPROVE ✓
# Phase 5: Creating Pull Request ✓
# PR: https://github.com/decisional/autodex/pull/123

# Workflow completed!
```

### Example 2: Review Iteration

```bash
./cc-workflow start LIN-789

# Output:
# ...
# Phase 4: Reviewing (Codex) - REQUEST_CHANGES
# Phase 3: Executing (Claude) - Iteration 2 ✓
# Phase 4: Reviewing (Codex) - APPROVE ✓
# Phase 5: Creating Pull Request ✓
```

### Example 3: Manual Intervention

```bash
./cc-workflow start LIN-101

# Output:
# ...
# Phase 3: Executing (Claude) - ERROR
# Workflow paused - manual intervention required

# Debug
./cc-workflow status LIN-101
docker exec -it claude-workflow-LIN-101-claude-code-1 bash
# ... fix issue ...

# Resume
./cc-workflow resume LIN-101
```

## File Structure

```
llm-docker/
├── cc-workflow                     # Main CLI
├── workflow-orchestrator.sh        # State machine
├── scripts/
│   ├── fetch-linear-ticket.sh
│   ├── run-planner.sh
│   ├── run-executor.sh
│   ├── run-reviewer.sh
│   └── create-pr.sh
├── workflow-data/                  # (gitignored)
│   └── {ticket-id}/
│       ├── workflow-state.json
│       ├── linear-ticket.md
│       ├── plan.md
│       ├── executor-response.md
│       ├── review.md
│       └── agent-logs/
└── WORKFLOW-README.md (this file)
```

## Contributing

To extend the workflow:

1. **Add new agent types**: Create new run-{agent}.sh script
2. **Add new phases**: Update workflow-orchestrator.sh state machine
3. **Modify prompts**: Edit agent scripts' PROMPT variables
4. **Change iteration logic**: Update workflow-orchestrator.sh REVIEWING phase

## Support

For issues or questions:
- Check workflow-data/{ticket-id}/agent-logs/
- Review workflow-state.json for current state
- Use `./cc-workflow status` for overview
- Check container logs: `docker logs claude-workflow-{ticket-id}-claude-code-1`
