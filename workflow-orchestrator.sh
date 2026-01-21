#!/bin/bash
# Workflow orchestrator - runs inside container
# Coordinates agent execution through workflow phases

set -e

TICKET_ID=$1
STATE_DIR="/workspace/.workflow-state/$TICKET_ID"
STATE_FILE="$STATE_DIR/workflow-state.json"
SCRIPTS_DIR="/workspace/.workflow-scripts"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_phase() {
    echo ""
    echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}  $1${NC}"
    echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
    echo ""
}

# Update workflow state
update_state() {
    local phase=$1
    local status=$2
    local error=${3:-null}

    jq --arg phase "$phase" \
       --arg status "$status" \
       --arg error "$error" \
       --arg updated "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
       '.phase = $phase | .status = $status | .error = (if $error == "null" then null else $error end) | .updated_at = $updated' \
       "$STATE_FILE" > "$STATE_FILE.tmp"
    mv "$STATE_FILE.tmp" "$STATE_FILE"
}

# Increment iteration counter
increment_iteration() {
    jq '.iteration += 1' "$STATE_FILE" > "$STATE_FILE.tmp"
    mv "$STATE_FILE.tmp" "$STATE_FILE"
}

# Get current state values
get_state_value() {
    jq -r ".$1" "$STATE_FILE"
}

# Run agent with error handling
run_agent() {
    local agent_name=$1
    local script_path=$2
    shift 2
    local args="$@"

    log_info "Starting agent: $agent_name"

    local log_file="$STATE_DIR/agent-logs/${agent_name}_$(date +%Y%m%d_%H%M%S).log"

    # Run agent and capture exit code
    if bash "$script_path" $args 2>&1 | tee "$log_file"; then
        log_success "Agent completed: $agent_name"
        return 0
    else
        local exit_code=$?
        log_error "Agent failed: $agent_name (exit code: $exit_code)"
        return $exit_code
    fi
}

# Pause workflow on error
pause_workflow() {
    local error_msg=$1

    log_error "$error_msg"
    update_state "$(get_state_value phase)" "PAUSED" "$error_msg"

    echo ""
    log_warning "Workflow paused - manual intervention required"
    log_info "To resume: ./cc-workflow resume $TICKET_ID"
    echo ""

    exit 1
}

# Main workflow state machine
run_workflow() {
    local current_phase=$(get_state_value phase)
    local current_status=$(get_state_value status)
    local current_iteration=$(get_state_value iteration)
    local max_iterations=$(get_state_value max_iterations)

    log_info "Workflow: $TICKET_ID"
    log_info "Phase: $current_phase"
    log_info "Status: $current_status"
    log_info "Iteration: $current_iteration/$max_iterations"
    echo ""

    # If paused, check if user wants to continue
    if [ "$current_status" = "PAUSED" ]; then
        log_warning "Workflow was paused"
        read -p "Continue from current phase? (y/n): " -n 1 -r
        echo ""

        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log_info "Workflow remains paused"
            exit 0
        fi

        update_state "$current_phase" "RUNNING"
    fi

    # Phase: INIT - Fetch Linear ticket
    if [ "$current_phase" = "INIT" ]; then
        log_phase "Phase 1: Fetching Linear Ticket"

        update_state "INIT" "RUNNING"

        if run_agent "fetch-linear-ticket" "$SCRIPTS_DIR/fetch-linear-ticket.sh" "$TICKET_ID" "$STATE_DIR"; then
            update_state "PLANNING" "RUNNING"
        else
            pause_workflow "Failed to fetch Linear ticket"
        fi
    fi

    # Phase: PLANNING - Codex creates plan
    current_phase=$(get_state_value phase)
    if [ "$current_phase" = "PLANNING" ]; then
        log_phase "Phase 2: Planning (Codex)"

        update_state "PLANNING" "RUNNING"

        if run_agent "planner" "$SCRIPTS_DIR/run-planner.sh" "$STATE_DIR"; then
            update_state "EXECUTING" "RUNNING"
        else
            pause_workflow "Planner agent failed"
        fi
    fi

    # Phase: EXECUTING - Claude implements changes
    current_phase=$(get_state_value phase)
    if [ "$current_phase" = "EXECUTING" ]; then
        log_phase "Phase 3: Executing (Claude)"

        update_state "EXECUTING" "RUNNING"

        if run_agent "executor" "$SCRIPTS_DIR/run-executor.sh" "$STATE_DIR"; then
            # After execution, create/update PR before review
            update_state "PR" "RUNNING"
        else
            pause_workflow "Executor agent failed"
        fi
    fi

    # Phase: PR - Create or update pull request
    current_phase=$(get_state_value phase)
    current_iteration=$(get_state_value iteration)

    if [ "$current_phase" = "PR" ]; then
        if [ "$current_iteration" -eq 0 ]; then
            log_phase "Phase 4: Creating Pull Request"
        else
            log_phase "Phase 4: Updating Pull Request (Iteration $current_iteration)"
        fi

        update_state "PR" "RUNNING"

        if run_agent "create-pr" "$SCRIPTS_DIR/create-pr.sh" "$STATE_DIR"; then
            update_state "REVIEWING" "RUNNING"
        else
            pause_workflow "Failed to create/update pull request"
        fi
    fi

    # Phase: REVIEWING - Codex reviews changes
    current_phase=$(get_state_value phase)
    current_iteration=$(get_state_value iteration)

    if [ "$current_phase" = "REVIEWING" ]; then
        log_phase "Phase 5: Reviewing (Codex) - Review Cycle $((current_iteration + 1))"

        update_state "REVIEWING" "RUNNING"

        if run_agent "reviewer" "$SCRIPTS_DIR/run-reviewer.sh" "$STATE_DIR"; then
            # Check review decision
            if [ -f "$STATE_DIR/review.md" ]; then
                local review_decision=$(head -n 1 "$STATE_DIR/review.md" | tr -d '\n\r' | tr '[:upper:]' '[:lower:]')

                log_info "Review decision: $review_decision"

                if echo "$review_decision" | grep -q "approve"; then
                    log_success "Changes approved by reviewer!"
                    update_state "COMPLETED" "COMPLETED"
                    log_phase "🎉 Workflow Completed Successfully! PR is ready for merge."
                elif echo "$review_decision" | grep -q "request"; then
                    log_warning "Reviewer requested changes"

                    increment_iteration
                    current_iteration=$(get_state_value iteration)

                    if [ "$current_iteration" -ge "$max_iterations" ]; then
                        pause_workflow "Maximum review iterations ($max_iterations) reached - check PR for details"
                    else
                        log_info "Starting review cycle $((current_iteration + 1))"
                        update_state "EXECUTING" "RUNNING"
                    fi
                else
                    pause_workflow "Could not determine review decision from review.md"
                fi
            else
                pause_workflow "review.md not found after reviewer execution"
            fi
        else
            pause_workflow "Reviewer agent failed"
        fi
    fi

    # If still running after all phases, loop back
    current_phase=$(get_state_value phase)
    current_status=$(get_state_value status)

    if [ "$current_status" = "RUNNING" ] && [ "$current_phase" != "COMPLETED" ]; then
        log_info "Continuing to next phase..."
        sleep 2
        run_workflow
    fi
}

# Validate environment
if [ -z "$TICKET_ID" ]; then
    log_error "Ticket ID required"
    echo "Usage: $0 <ticket-id>"
    exit 1
fi

if [ ! -f "$STATE_FILE" ]; then
    log_error "Workflow state file not found: $STATE_FILE"
    exit 1
fi

if [ ! -d "$SCRIPTS_DIR" ]; then
    log_error "Workflow scripts directory not found: $SCRIPTS_DIR"
    exit 1
fi

# Start workflow
log_info "Starting workflow orchestrator for ticket: $TICKET_ID"
echo ""

run_workflow

# Final status
final_status=$(get_state_value status)
final_phase=$(get_state_value phase)

echo ""
log_info "Final status: $final_status"
log_info "Final phase: $final_phase"

if [ "$final_status" = "COMPLETED" ]; then
    exit 0
else
    exit 1
fi
