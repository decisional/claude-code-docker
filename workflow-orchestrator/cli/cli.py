#!/usr/bin/env python3
"""CLI for workflow orchestrator."""

import sys
import argparse
import logging
from pathlib import Path
from tabulate import tabulate
from datetime import datetime

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from orchestrator.config import load_config
from orchestrator.workflow_manager import WorkflowManager
from orchestrator.models import WorkflowState, AgentType

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def cmd_start(args):
    """Start a new workflow."""
    config = load_config(args.config)

    # Validate config
    errors = config.validate()
    if errors:
        print("❌ Configuration errors:")
        for error in errors:
            print(f"  - {error}")
        return 1

    manager = WorkflowManager(config)

    # Parse agent types if provided
    planner = AgentType(args.planner) if args.planner else None
    executor = AgentType(args.executor) if args.executor else None

    try:
        # Create workflow
        workflow = manager.create_workflow(
            linear_ticket_id=args.ticket_id,
            planner_model=planner,
            executor_model=executor
        )

        print(f"✓ Workflow created: {workflow.id}")
        print(f"  Ticket: {workflow.linear_ticket_id} - {workflow.ticket_title}")
        print(f"  Branch: {workflow.branch_name}")
        print(f"  Planner: {workflow.planner_model.value}")
        print(f"  Executor: {workflow.executor_model.value}")
        print()

        # Start workflow
        print("Starting workflow...")
        manager.start_workflow(workflow)

        print(f"✓ Workflow {workflow.id} started")
        print(f"  State: {workflow.state.value}")

    except Exception as e:
        print(f"❌ Error: {e}")
        logger.exception("Failed to start workflow")
        return 1

    return 0


def cmd_list(args):
    """List all workflows."""
    config = load_config(args.config)
    manager = WorkflowManager(config)

    # Filter by state if requested
    state_filter = None
    if args.blocked:
        workflows = [
            w for w in manager.list_workflows()
            if w.state in [WorkflowState.PLANNING_BLOCKED, WorkflowState.EXECUTION_BLOCKED]
        ]
    elif args.state:
        state_filter = WorkflowState(args.state)
        workflows = manager.list_workflows(state_filter)
    else:
        workflows = manager.list_workflows()

    if not workflows:
        print("No workflows found")
        return 0

    # Prepare table data
    table_data = []
    for w in workflows:
        # Format updated time
        try:
            updated = datetime.fromisoformat(w.updated_at)
            time_ago = _time_ago(updated)
        except:
            time_ago = w.updated_at

        # Truncate branch name
        branch = w.branch_name[:40] + "..." if len(w.branch_name) > 40 else w.branch_name

        row = [
            w.id,
            w.linear_ticket_id,
            w.state.value,
            branch,
            time_ago
        ]

        # Add question if blocked
        if args.blocked and w.block_info:
            row.append(w.block_info.question[:60] + "...")

        table_data.append(row)

    # Print table
    headers = ["ID", "TICKET", "STATE", "BRANCH", "UPDATED"]
    if args.blocked:
        headers.append("QUESTION")

    print(tabulate(table_data, headers=headers, tablefmt="simple"))
    print(f"\nTotal: {len(workflows)} workflow(s)")

    return 0


def cmd_show(args):
    """Show detailed workflow information."""
    config = load_config(args.config)
    manager = WorkflowManager(config)

    workflow = manager.load_workflow(args.workflow_id)
    if not workflow:
        print(f"❌ Workflow not found: {args.workflow_id}")
        return 1

    print(f"Workflow: {workflow.id}")
    print(f"{'='*60}")
    print(f"Linear Ticket: {workflow.linear_ticket_id} - {workflow.ticket_title}")
    print(f"State: {workflow.state.value}")
    print(f"Created: {workflow.created_at}")
    print(f"Updated: {workflow.updated_at}")
    print()
    print(f"Configuration:")
    print(f"  Branch: {workflow.branch_name}")
    print(f"  Planner: {workflow.planner_model.value}")
    print(f"  Executor: {workflow.executor_model.value}")
    print()

    if workflow.ticket_assignee:
        print(f"Assignee: {workflow.ticket_assignee}")
    if workflow.ticket_project:
        print(f"Project: {workflow.ticket_project}")

    print()

    # Show plan file if exists
    if workflow.plan_file_path:
        print(f"Plan: {workflow.plan_file_path}")

    # Show PR if created
    if workflow.pr_url:
        print(f"PR: {workflow.pr_url}")

    print()

    # Show block info if blocked
    if workflow.is_blocked() and workflow.block_info:
        print("🚧 BLOCKED")
        print(f"Reason: {workflow.block_info.reason}")
        print(f"Question: {workflow.block_info.question}")
        if workflow.block_info.options:
            print(f"Options: {', '.join(workflow.block_info.options)}")
        print()

    # Show error if failed
    if workflow.state == WorkflowState.FAILED and workflow.error_message:
        print("❌ FAILED")
        print(f"Error: {workflow.error_message}")
        print()

    # Show container ID
    if workflow.container_id:
        print(f"Container: {workflow.container_id[:12]}")
        if workflow.container_name:
            print(f"Container Name: {workflow.container_name}")

    return 0


def cmd_respond(args):
    """Respond to a blocked workflow."""
    config = load_config(args.config)
    manager = WorkflowManager(config)

    workflow = manager.load_workflow(args.workflow_id)
    if not workflow:
        print(f"❌ Workflow not found: {args.workflow_id}")
        return 1

    if not workflow.is_blocked():
        print(f"❌ Workflow is not blocked (state: {workflow.state.value})")
        return 1

    # Show question
    print(f"Workflow: {workflow.id}")
    print(f"Question: {workflow.block_info.question}")
    if workflow.block_info.options:
        print(f"Options: {', '.join(workflow.block_info.options)}")
    print()

    # Get response
    if args.response:
        response = args.response
    else:
        response = input("Your response: ").strip()

    if not response:
        print("❌ Response cannot be empty")
        return 1

    # Submit response
    try:
        manager.respond_to_workflow(workflow, response)
        print(f"✓ Response submitted: {response}")
        print(f"  Workflow resuming...")
    except Exception as e:
        print(f"❌ Error: {e}")
        logger.exception("Failed to respond to workflow")
        return 1

    return 0


def cmd_logs(args):
    """Show container logs for a workflow."""
    config = load_config(args.config)
    manager = WorkflowManager(config)

    workflow = manager.load_workflow(args.workflow_id)
    if not workflow:
        print(f"❌ Workflow not found: {args.workflow_id}")
        return 1

    # Get container ID
    container_id = workflow.container_id

    if not container_id:
        print("❌ No container found for this workflow")
        return 1

    print(f"=== Workflow Logs ({container_id[:12]}) ===\n")

    # Get logs
    tail = args.tail if args.tail else None
    logs = manager.docker_manager.get_container_logs(container_id, tail=tail)

    print(logs)

    return 0


def cmd_cancel(args):
    """Cancel a running workflow."""
    config = load_config(args.config)
    manager = WorkflowManager(config)

    workflow = manager.load_workflow(args.workflow_id)
    if not workflow:
        print(f"❌ Workflow not found: {args.workflow_id}")
        return 1

    if workflow.is_terminal():
        print(f"❌ Workflow is already in terminal state: {workflow.state.value}")
        return 1

    # Stop container
    if workflow.container_id:
        try:
            manager.docker_manager.stop_container(workflow.container_id)
            manager.docker_manager.remove_container(workflow.container_id, force=True)
            print(f"✓ Stopped workflow container")
        except Exception as e:
            logger.warning(f"Failed to stop container: {e}")

    # Update state
    workflow.update_state(WorkflowState.CANCELLED)
    manager._save_workflow(workflow)

    print(f"✓ Workflow cancelled: {workflow.id}")

    return 0


def cmd_interact(args):
    """Start an interactive session with the agent."""
    config = load_config(args.config)
    manager = WorkflowManager(config)

    workflow = manager.load_workflow(args.workflow_id)
    if not workflow:
        print(f"❌ Workflow not found: {args.workflow_id}")
        return 1

    # Get container ID
    container_id = workflow.container_id

    if not container_id:
        print("❌ No active container found for this workflow")
        return 1

    # Determine which agent/phase
    if workflow.state in [WorkflowState.PLANNING, WorkflowState.PLANNING_BLOCKED, WorkflowState.PLANNED]:
        agent_type = workflow.planner_model
        phase = "planning"
    else:
        agent_type = workflow.executor_model
        phase = "execution"

    # Check if container is running
    if not manager.docker_manager.is_container_running(container_id):
        print(f"❌ Container is not running (status: {manager.docker_manager.get_container_status(container_id)})")
        return 1

    print(f"Workflow: {workflow.id}")
    print(f"Ticket: {workflow.linear_ticket_id} - {workflow.ticket_title}")
    print(f"State: {workflow.state.value}")
    print(f"Phase: {phase}")
    print(f"Agent: {agent_type.value}")
    print()

    # Build context prompt
    context_lines = [
        f"You are helping with workflow {workflow.id} for Linear ticket {workflow.linear_ticket_id}.",
        f"Ticket: {workflow.ticket_title}",
    ]

    if workflow.is_blocked() and workflow.block_info:
        context_lines.extend([
            "",
            f"The workflow is currently blocked on this question:",
            f"{workflow.block_info.question}",
        ])
        if workflow.block_info.options:
            context_lines.append(f"Options: {', '.join(workflow.block_info.options)}")
        context_lines.extend([
            "",
            "The human wants to discuss this with you interactively.",
            "After the discussion, help them formulate a clear answer.",
        ])
    else:
        context_lines.extend([
            "",
            f"Current state: {workflow.state.value}",
            "The human wants to chat with you about this workflow.",
        ])

    context_lines.extend([
        "",
        "Working directory: /workspace",
        f"Ticket details: /workspace/linear-ticket.md",
    ])

    if workflow.plan_file_path:
        context_lines.append(f"Plan: /workspace/{workflow.plan_file_path}")

    context_prompt = "\n".join(context_lines)

    # Start interactive session
    try:
        manager.docker_manager.start_interactive_session(
            container_id=container_id,
            agent_type=agent_type,
            context_prompt=context_prompt
        )

        # After interactive session, check if user wants to save a response
        if workflow.is_blocked():
            print("\n" + "="*60)
            print("The workflow is still blocked.")
            print(f"Question: {workflow.block_info.question}")
            print()
            save_response = input("Did you reach a decision? (y/n): ").strip().lower()

            if save_response == 'y':
                response = input("Enter the decision/response: ").strip()
                if response:
                    manager.respond_to_workflow(workflow, response)
                    print(f"✓ Response saved: {response}")
                    print("  Workflow will resume automatically")
            else:
                print("No response saved. Workflow remains blocked.")
                print("You can respond later with: ./workflow respond " + workflow.id)

    except Exception as e:
        print(f"❌ Error: {e}")
        logger.exception("Failed to start interactive session")
        return 1

    return 0


def cmd_shell(args):
    """Open a shell in the workflow container."""
    config = load_config(args.config)
    manager = WorkflowManager(config)

    workflow = manager.load_workflow(args.workflow_id)
    if not workflow:
        print(f"❌ Workflow not found: {args.workflow_id}")
        return 1

    # Get container ID
    container_id = workflow.container_id

    if not container_id:
        print("❌ No active container found for this workflow")
        return 1

    # Determine phase
    if workflow.state in [WorkflowState.PLANNING, WorkflowState.PLANNING_BLOCKED, WorkflowState.PLANNED]:
        phase = "planning"
    else:
        phase = "execution"

    # Check if container is running
    if not manager.docker_manager.is_container_running(container_id):
        print(f"❌ Container is not running (status: {manager.docker_manager.get_container_status(container_id)})")
        return 1

    print(f"Workflow: {workflow.id}")
    print(f"Phase: {phase}")
    print(f"Container: {container_id[:12]}")
    print()

    # Open shell
    try:
        manager.docker_manager.open_shell_in_container(container_id, args.shell)
    except Exception as e:
        print(f"❌ Error: {e}")
        logger.exception("Failed to open shell")
        return 1

    return 0


def _time_ago(dt: datetime) -> str:
    """Format datetime as 'X ago' string."""
    now = datetime.utcnow()
    diff = now - dt

    seconds = diff.total_seconds()
    if seconds < 60:
        return f"{int(seconds)}s ago"
    elif seconds < 3600:
        return f"{int(seconds / 60)}m ago"
    elif seconds < 86400:
        return f"{int(seconds / 3600)}h ago"
    else:
        return f"{int(seconds / 86400)}d ago"


def main():
    """Main CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Workflow Orchestrator - Automate Linear ticket to PR workflow"
    )
    parser.add_argument(
        "--config",
        help="Path to config file (default: use environment variables)"
    )

    subparsers = parser.add_subparsers(dest="command", help="Commands")

    # start command
    start_parser = subparsers.add_parser("start", help="Start a new workflow")
    start_parser.add_argument("ticket_id", help="Linear ticket ID (e.g., DEC-123)")
    start_parser.add_argument("--planner", choices=["claude", "codex"], help="Planner model")
    start_parser.add_argument("--executor", choices=["claude", "codex"], help="Executor model")
    start_parser.set_defaults(func=cmd_start)

    # list command
    list_parser = subparsers.add_parser("list", help="List workflows")
    list_parser.add_argument("--state", help="Filter by state")
    list_parser.add_argument("--blocked", action="store_true", help="Show only blocked workflows")
    list_parser.set_defaults(func=cmd_list)

    # show command
    show_parser = subparsers.add_parser("show", help="Show workflow details")
    show_parser.add_argument("workflow_id", help="Workflow ID")
    show_parser.set_defaults(func=cmd_show)

    # respond command
    respond_parser = subparsers.add_parser("respond", help="Respond to a blocked workflow")
    respond_parser.add_argument("workflow_id", help="Workflow ID")
    respond_parser.add_argument("-r", "--response", help="Response text (interactive if not provided)")
    respond_parser.set_defaults(func=cmd_respond)

    # logs command
    logs_parser = subparsers.add_parser("logs", help="Show container logs")
    logs_parser.add_argument("workflow_id", help="Workflow ID")
    logs_parser.add_argument("--tail", type=int, help="Number of lines to show")
    logs_parser.set_defaults(func=cmd_logs)

    # cancel command
    cancel_parser = subparsers.add_parser("cancel", help="Cancel a running workflow")
    cancel_parser.add_argument("workflow_id", help="Workflow ID")
    cancel_parser.set_defaults(func=cmd_cancel)

    # interact command
    interact_parser = subparsers.add_parser("interact", help="Start interactive session with agent")
    interact_parser.add_argument("workflow_id", help="Workflow ID")
    interact_parser.set_defaults(func=cmd_interact)

    # shell command
    shell_parser = subparsers.add_parser("shell", help="Open shell in workflow container")
    shell_parser.add_argument("workflow_id", help="Workflow ID")
    shell_parser.add_argument("--shell", default="/bin/bash", help="Shell to use (default: /bin/bash)")
    shell_parser.set_defaults(func=cmd_shell)

    # Parse args
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 1

    # Execute command
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
