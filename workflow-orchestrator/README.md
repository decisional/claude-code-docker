## Workflow Orchestrator

Automates the complete workflow from Linear ticket to Pull Request using AI agents.

## Overview

```
Linear Ticket → Planner Agent → Implementation Plan → Executor Agent → Pull Request
```

The orchestrator:
1. Fetches ticket details from Linear (including screenshots/attachments)
2. **Downloads and prepares screenshots** so agents can see visual requirements
3. Spins up a planner agent (Codex or Claude) to create an implementation plan
4. Spins up an executor agent (Claude or Codex) to implement the plan
5. Monitors progress and handles human-in-the-loop when agents need input
6. Creates a PR and updates the Linear ticket

### 🖼️ Screenshot Handling

Agents can **see and analyze** screenshots from Linear tickets:

- Screenshots are downloaded to `attachments/` folder
- A `SCREENSHOTS.md` manifest is created with explicit viewing instructions
- Images are embedded in the ticket markdown
- Agents use the Read tool to view images (Claude and GPT-4V are multimodal)
- Visual requirements (UI layouts, colors, spacing) are properly analyzed

See [SCREENSHOTS.md](../SCREENSHOT_HANDLING.md) for full details on how screenshot handling works.

## Setup

### 1. Install dependencies

```bash
cd workflow-orchestrator
pip install -r requirements.txt
```

### 2. Configure

Create a `config.yaml` file (or use environment variables):

```yaml
# Minimum required config
linear_api_key: "lin_api_your_key_here"
repo_url: "git@github.com:your-org/your-repo.git"
```

Or use environment variables:
```bash
export LINEAR_API_KEY="lin_api_your_key_here"
export GIT_REPO_URL="git@github.com:your-org/your-repo.git"
```

Get your Linear API key from: https://linear.app/settings/api

### 3. Build Docker image

```bash
cd ..  # Back to llm-docker root
./build.sh
```

### 4. Create CLI symlink

```bash
ln -s $(pwd)/workflow-orchestrator/cli/cli.py $(pwd)/workflow
chmod +x workflow
```

## Usage

### Start a workflow

```bash
./workflow start DEC-123
```

This will:
- Fetch ticket DEC-123 from Linear
- Create a workflow directory in `./workflows/wf_xxxxx/`
- Start the planner agent
- Monitor progress automatically

### List workflows

```bash
# List all workflows
./workflow list

# List only blocked workflows
./workflow list --blocked

# Filter by state
./workflow list --state planning
```

### View workflow details

```bash
./workflow show wf_abc123
```

### Respond to blocked workflow

When a workflow is blocked (waiting for human input):

```bash
# Interactive mode
./workflow respond wf_abc123

# Or provide response directly
./workflow respond wf_abc123 -r "Use PostgreSQL"
```

### View container logs

```bash
# Show planner logs
./workflow logs wf_abc123

# Show executor logs
./workflow logs wf_abc123 --executor

# Show last 50 lines
./workflow logs wf_abc123 --tail 50
```

### Cancel a workflow

```bash
./workflow cancel wf_abc123
```

## Configuration

### Full config.yaml example

```yaml
# Linear API
linear_api_key: "lin_api_xxx"
linear_team_id: null

# Git
repo_url: "git@github.com:org/repo.git"
base_branch: "main"

# Models (claude or codex)
default_planner: "codex"
default_executor: "claude"

# Docker
docker_image: "llm-docker-claude-code:latest"
workspace_base: "/workspace"

# Paths
workflows_dir: "./workflows"
db_path: "./workflow.db"

# Timeouts (minutes)
planning_timeout: 30
execution_timeout: 120
container_check_interval: 5

# Notifications
slack_webhook_url: "https://hooks.slack.com/..."
notify_on_block: true
notify_on_complete: true

# GitHub
github_token: "ghp_xxx"  # or use gh CLI auth
```

### Environment variables

All config can be set via environment variables:

- `LINEAR_API_KEY` - Required
- `LINEAR_TEAM_ID`
- `GIT_REPO_URL` - Required
- `GIT_BASE_BRANCH`
- `DEFAULT_PLANNER` (claude or codex)
- `DEFAULT_EXECUTOR` (claude or codex)
- `GITHUB_TOKEN`
- `SLACK_WEBHOOK_URL`

## How It Works

### Workflow States

```
PENDING → FETCHING_TICKET → PLANNING → PLANNED → EXECUTING → COMPLETED
                                ↓                      ↓
                        PLANNING_BLOCKED      EXECUTION_BLOCKED
                                ↓                      ↓
                           (human input)         (human input)
                                ↓                      ↓
                            PLANNING              EXECUTING
```

### Agent Protocol

Agents signal their status by writing to `/workspace/.workflow-status.json`:

**When complete:**
```json
{
  "status": "complete",
  "output_file": "plan.md",
  "message": "Optional message"
}
```

**When blocked (need human input):**
```json
{
  "status": "blocked",
  "question": "Which database should we use?",
  "options": ["PostgreSQL", "MySQL", "MongoDB"],
  "message": "Context about why blocked"
}
```

**When error:**
```json
{
  "status": "error",
  "message": "Error description"
}
```

When blocked, orchestrator writes human response to `/workspace/.workflow-resume.json`:
```json
{
  "response": "PostgreSQL"
}
```

### Workflow Directory Structure

```
workflows/
└── wf_abc123/
    ├── metadata.json           # Workflow state
    ├── linear-ticket.md        # Ticket details
    ├── attachments/            # Screenshots, etc.
    │   └── screenshot.png
    ├── plan.md                 # Generated by planner
    ├── .workflow-status.json   # Agent status signals
    └── .workflow-resume.json   # Human responses
```

## Examples

### Basic workflow

```bash
# Start workflow for ticket DEC-123
$ ./workflow start DEC-123

✓ Workflow created: wf_abc123
  Ticket: DEC-123 - Add user export feature
  Branch: feature/DEC-123-add-user-export-feature
  Planner: codex
  Executor: claude

Starting workflow...
✓ Workflow wf_abc123 started
  State: planning

# Check status
$ ./workflow show wf_abc123

Workflow: wf_abc123
============================================================
Linear Ticket: DEC-123 - Add user export feature
State: executing
Created: 2026-01-20T10:00:00
Updated: 2026-01-20T10:15:00

Configuration:
  Branch: feature/DEC-123-add-user-export-feature
  Planner: codex
  Executor: claude

Plan: plan.md

# When complete
$ ./workflow show wf_abc123

...
State: completed
PR: https://github.com/org/repo/pull/456
```

### Handling blocked workflow

```bash
# Workflow gets blocked
$ ./workflow list --blocked

ID         TICKET    STATE              QUESTION
wf_abc123  DEC-123   execution_blocked  Which export formats to support?

# Respond to it
$ ./workflow respond wf_abc123

Workflow: wf_abc123
Question: Which export formats to support?
Options: CSV, JSON, Excel, PDF

Your response: CSV and JSON

✓ Response submitted: CSV and JSON
  Workflow resuming...
```

## Troubleshooting

### Workflow stuck in planning

Check planner logs:
```bash
./workflow logs wf_abc123 --tail 100
```

### Agent not signaling status

Agents must write status to `/workspace/.workflow-status.json`. Check the prompt templates in `templates/` to ensure agents know the protocol.

### Container permissions issues

Ensure you've run `./build.sh` which sets up proper user permissions in the Docker image.

### Linear API errors

Verify your API key:
```bash
curl -H "Authorization: YOUR_API_KEY" https://api.linear.app/graphql -d '{"query": "{ viewer { id name } }"}'
```

## Architecture

See the parent README for full system architecture. Key components:

- **WorkflowManager**: Orchestrates the entire flow
- **LinearClient**: Interacts with Linear API
- **DockerManager**: Manages agent containers
- **CLI**: User interface

All workflow state is persisted to disk in `workflows/` directory and can survive crashes/restarts.
