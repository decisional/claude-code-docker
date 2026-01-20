# Code Review Agent - How It Works

## Overview

After the executor completes the implementation, a review agent (Codex by default) reviews the code and can send it back to the executor for fixes.

## The Flow

```
┌──────────┐     ┌──────────┐     ┌──────────┐
│ Planner  │ →   │ Executor │ →   │ Reviewer │
│ (Codex)  │     │ (Claude) │     │ (Codex)  │
└──────────┘     └──────────┘     └────┬─────┘
                                       │
                        ┌──────────────┴──────────────┐
                        ↓                             ↓
                   ✅ APPROVED                    ❌ NEEDS REWORK
                        ↓                             ↓
                   Create PR                    Send feedback
                        ↓                             ↓
                   COMPLETED              ┌───────────┘
                                          ↓
                                     Executor fixes
                                          ↓
                                     Reviewer again
                                          ↓
                                    (Max 3 iterations)
```

## Detailed Flow

### Step 1: Executor Completes

```
Executor (Claude):
- Implements all features from plan
- Writes code, creates files
- Signals complete via .workflow-status.json

File: /workspace/.workflow-status.json
{
  "status": "complete",
  "message": "Implementation complete"
}
```

### Step 2: Reviewer Analyzes Code

```
Reviewer (Codex):
- Reads /workspace/plan.md (what should be implemented)
- Reads /workspace/linear-ticket.md (original requirements)
- Reviews code changes (git diff, git status)
- Checks for:
  ✓ Missing features
  ✓ Bugs or logic errors
  ✓ Security vulnerabilities
  ✓ Code quality issues
  ✓ UI/UX matching screenshots
```

### Step 3A: If Approved

```
Reviewer writes:
/workspace/.workflow-status.json
{
  "status": "complete",
  "message": "Code review passed. Ready for PR.",
  "review_result": "approved",
  "review_notes": "Implementation looks good. All features present."
}

Orchestrator:
→ Creates PR
→ Updates Linear ticket
→ State: COMPLETED
→ Cleans up container
```

### Step 3B: If Issues Found

```
Reviewer writes:
/workspace/.review-feedback.json
{
  "issues": [
    {
      "severity": "high",
      "file": "src/api/users.ts",
      "line": 45,
      "issue": "Missing email validation",
      "suggestion": "Add email format check before DB insert"
    },
    {
      "severity": "medium",
      "file": "src/components/Profile.tsx",
      "line": 23,
      "issue": "User input not sanitized",
      "suggestion": "Use DOMPurify for XSS protection"
    }
  ],
  "summary": "Found 2 security issues that must be fixed"
}

/workspace/.workflow-status.json
{
  "status": "needs_rework",
  "message": "Found 2 issues that need to be fixed"
}

Orchestrator:
→ Loads feedback
→ Saves to workflow.review_feedback
→ State: NEEDS_REWORK
→ Increments review_iteration
→ Re-runs executor with feedback
```

### Step 4: Executor Fixes Issues

```
Executor (Claude) receives modified prompt:

## REVIEW FEEDBACK - NEEDS REWORK

The code reviewer found issues that need to be fixed:

{
  "issues": [
    {
      "severity": "high",
      "file": "src/api/users.ts",
      "line": 45,
      "issue": "Missing email validation",
      "suggestion": "Add email format check before DB insert"
    },
    ...
  ]
}

Please address all the issues mentioned above and update your implementation.

[Original executor prompt continues...]

Executor:
- Reads the feedback
- Fixes each issue
- Signals complete

Orchestrator:
→ Starts review phase again (iteration 2)
```

### Step 5: Review Again

The cycle repeats:
- Reviewer checks fixes
- If approved → Create PR
- If still has issues → Send back again
- If iteration >= 3 → Block for human intervention

## Max Iteration Protection

```
Iteration 1: Executor → Reviewer → Needs rework
Iteration 2: Executor fixes → Reviewer → Needs rework
Iteration 3: Executor fixes → Reviewer → Needs rework
Iteration 4: BLOCKED!

Workflow state: REVIEW_BLOCKED
Question: "Review has failed 3 times. How should we proceed?"
Options:
  - "Approve and create PR anyway"
  - "Cancel workflow"
  - "Manual intervention needed"
```

## Example Workflow

```bash
$ ./workflow start DEC-123

✓ Workflow created: wf_abc123
  Planner: codex
  Executor: claude
  Reviewer: codex

# Phase 1: Planning
[10:00] State: planning
[10:02] Plan created

# Phase 2: Execution
[10:02] State: executing
[10:10] Implementation complete

# Phase 3: Review (Iteration 1)
[10:10] State: reviewing
[10:12] Review found 3 issues

# Phase 2 (again): Fix issues
[10:12] State: needs_rework
[10:12] State: executing (with feedback)
[10:15] Fixes applied

# Phase 3 (again): Review (Iteration 2)
[10:15] State: reviewing
[10:17] Review approved!

# Create PR
[10:17] State: creating_pr
[10:18] PR created: https://github.com/org/repo/pull/456
[10:18] State: completed
```

## Viewing Review Details

```bash
$ ./workflow show wf_abc123

Workflow: wf_abc123
============================================================
Linear Ticket: DEC-123 - Add user export
State: reviewing
Review Iteration: 2/3
Review Feedback: (see workflow directory for details)

# View feedback file
$ cat workflows/wf_abc123/.review-feedback.json

{
  "issues": [
    {
      "severity": "high",
      "file": "src/api/export.ts",
      "line": 23,
      "issue": "SQL injection vulnerability",
      "suggestion": "Use parameterized queries"
    }
  ],
  "summary": "Critical security issue must be fixed"
}
```

## Configuration

### Enable/Disable Review

```yaml
# config.yaml
review_enabled: true  # Set to false to skip review phase
```

Or via environment variable:
```bash
export REVIEW_ENABLED=false
./workflow start DEC-123  # No review, goes straight to PR
```

### Choose Review Model

```yaml
# config.yaml
default_reviewer: "codex"  # or "claude"
```

**Recommendation**: Use Codex for review
- Different "perspective" from Claude (executor)
- Good at finding bugs and inconsistencies
- Fresh eyes on the code

### Set Max Iterations

```yaml
# config.yaml
max_review_iterations: 3  # Default is 3
```

Higher = more chances to fix, but workflow takes longer
Lower = faster, but might miss some fixes

## Benefits

### Quality Assurance
✅ Automated code review before PR
✅ Catches bugs, security issues, missing features
✅ Ensures implementation matches plan
✅ Verifies UI matches screenshots

### Iterative Improvement
✅ Executor gets specific feedback on what to fix
✅ Multiple chances to get it right
✅ Human intervention if stuck in a loop

### Efficiency
✅ Only human intervention when really needed
✅ Most issues caught and fixed automatically
✅ Better PR quality = faster human reviews

## Review Categories

The reviewer checks for:

### 1. Correctness
- Does implementation match the plan?
- Are all features from the ticket implemented?
- Do the changes solve the actual problem?

### 2. Security
- SQL injection, XSS, CSRF vulnerabilities
- Authentication/authorization issues
- Input validation
- Data sanitization

### 3. Bugs
- Logic errors
- Edge cases not handled
- Null/undefined checks
- Error handling

### 4. Code Quality
- Follows project conventions
- Proper error handling
- Good variable names
- Adequate comments

### 5. Visual Match (if screenshots provided)
- UI matches mockups
- Colors, spacing correct
- Interactive elements work as shown

## Advanced Usage

### Override Reviewer

```bash
# Use Claude for review instead of default
./workflow start DEC-123 --reviewer claude
```

### Disable Review for Specific Workflow

```bash
# Start with review disabled
export REVIEW_ENABLED=false
./workflow start DEC-123
```

### Manual Review Control

```bash
# When workflow is blocked at max iterations
$ ./workflow list --blocked

ID         STATE          QUESTION
wf_abc123  review_blocked Review failed 3 times. Proceed?

# Approve anyway
$ ./workflow respond wf_abc123 -r "Approve and create PR anyway"

# Or cancel
$ ./workflow respond wf_abc123 -r "Cancel workflow"

# Or interact for manual review
$ ./workflow interact wf_abc123
# Chat with reviewer, understand issues, make decision
```

## Architecture Notes

All three phases run in the **same container**:

```
Container: workflow-wf_abc123
├── docker exec codex "planning prompt"    → plan.md
├── docker exec claude "execution prompt"  → implementation
├── docker exec codex "review prompt"      → feedback or approval
├── docker exec claude "fix feedback"      → fixes (if needed)
├── docker exec codex "review prompt"      → approval
└── docker exec claude "create PR"         → PR created
```

Benefits of same container:
- Shared filesystem (all agents see same files)
- Consistent git state
- Faster (no container restarts)
- Better for interactive mode

## Summary

The review agent adds **automated quality assurance** to your workflow:

✅ **Codex reviews** all implementations
✅ **Sends detailed feedback** back to executor
✅ **Iterative fixing** until code is good
✅ **Max 3 iterations** to prevent infinite loops
✅ **Human intervention** when needed
✅ **Configurable** - can enable/disable, choose model

Your code gets reviewed before creating a PR - automatically! 🎉
