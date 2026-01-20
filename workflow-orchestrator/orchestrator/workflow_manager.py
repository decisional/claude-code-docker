"""Workflow state machine and orchestration logic."""

import json
import logging
import uuid
from pathlib import Path
from typing import Optional, Dict, Any, List
from datetime import datetime

from .models import Workflow, WorkflowState, AgentType, BlockInfo
from .config import OrchestratorConfig
from .linear_client import LinearClient
from .docker_manager import DockerManager

logger = logging.getLogger(__name__)


class WorkflowManager:
    """Manages workflow lifecycle from Linear ticket to PR."""

    def __init__(self, config: OrchestratorConfig):
        self.config = config
        self.linear_client = LinearClient(config.linear_api_key)
        self.docker_manager = DockerManager(config.docker_image, config.workspace_base)
        self.workflows_dir = Path(config.workflows_dir)
        self.workflows_dir.mkdir(parents=True, exist_ok=True)

    def create_workflow(
        self,
        linear_ticket_id: str,
        planner_model: Optional[AgentType] = None,
        executor_model: Optional[AgentType] = None,
        review_model: Optional[AgentType] = None
    ) -> Workflow:
        """Create a new workflow from a Linear ticket."""
        logger.info(f"Creating workflow for ticket {linear_ticket_id}")

        # Generate workflow ID
        workflow_id = f"wf_{uuid.uuid4().hex[:8]}"

        # Use defaults from config if not specified
        if not planner_model:
            planner_model = AgentType(self.config.default_planner)
        if not executor_model:
            executor_model = AgentType(self.config.default_executor)
        if not review_model:
            review_model = AgentType(self.config.default_reviewer)

        # Fetch ticket from Linear
        logger.info(f"Fetching ticket from Linear...")
        issue = self.linear_client.get_issue(linear_ticket_id)

        # Generate branch name from ticket
        branch_name = self._generate_branch_name(issue)

        # Create workflow directory
        workflow_dir = self.workflows_dir / workflow_id
        workflow_dir.mkdir(parents=True, exist_ok=True)

        # Create workflow object
        workflow = Workflow(
            id=workflow_id,
            linear_ticket_id=linear_ticket_id,
            state=WorkflowState.PENDING,
            planner_model=planner_model,
            executor_model=executor_model,
            review_model=review_model,
            repo_url=self.config.repo_url,
            base_branch=self.config.base_branch,
            branch_name=branch_name,
            workflow_dir=str(workflow_dir),
            max_review_iterations=self.config.max_review_iterations,
            ticket_title=issue.get('title'),
            ticket_description=issue.get('description'),
            ticket_assignee=issue.get('assignee', {}).get('name'),
            ticket_project=issue.get('project', {}).get('name'),
        )

        # Save ticket details and attachments
        self._save_ticket_details(workflow, issue)

        # Save workflow metadata
        self._save_workflow(workflow)

        logger.info(f"Workflow created: {workflow_id}")
        return workflow

    def start_workflow(self, workflow: Workflow) -> Workflow:
        """Start executing a workflow."""
        logger.info(f"Starting workflow {workflow.id}")

        # Start single container for entire workflow
        container_name = f"workflow-{workflow.id}"
        workflow_dir = Path(workflow.workflow_dir)

        try:
            container_id = self.docker_manager.start_workflow_container(
                container_name=container_name,
                workflow_dir=workflow_dir,
                repo_url=workflow.repo_url,
                branch_name=workflow.branch_name,
                github_token=self.config.github_token
            )

            workflow.container_id = container_id
            workflow.container_name = container_name
            self._save_workflow(workflow)

            logger.info(f"Container started: {container_id[:12]}")

            # Run planning phase in the container
            workflow.update_state(WorkflowState.PLANNING)
            self._save_workflow(workflow)

            return self._run_planning_phase(workflow)

        except Exception as e:
            logger.error(f"Failed to start workflow: {e}")
            workflow.update_state(WorkflowState.FAILED, str(e))
            self._save_workflow(workflow)
            return workflow

    def _run_planning_phase(self, workflow: Workflow) -> Workflow:
        """Run the planning phase of the workflow."""
        logger.info(f"Starting planning phase for {workflow.id}")

        workflow_dir = Path(workflow.workflow_dir)

        # Load planner prompt template
        planner_prompt = self._get_planner_prompt(workflow)

        try:
            # Execute planner in the existing container
            self.docker_manager.exec_agent_in_container(
                container_id=workflow.container_id,
                agent_type=workflow.planner_model,
                prompt=planner_prompt,
                detached=True
            )

            # Monitor planning phase
            self._monitor_planning(workflow)

        except Exception as e:
            logger.error(f"Planning phase failed: {e}")
            workflow.update_state(WorkflowState.FAILED, str(e))
            self._save_workflow(workflow)

        return workflow

    def _monitor_planning(self, workflow: Workflow):
        """Monitor planning phase and handle state transitions."""
        container_id = workflow.container_id
        workflow_dir = Path(workflow.workflow_dir)

        logger.info(f"Monitoring planning phase in container {container_id[:12]}")

        for status, agent_status in self.docker_manager.wait_for_container(
            container_id,
            check_interval=self.config.container_check_interval,
            workflow_dir=workflow_dir
        ):
            if status == "blocked":
                # Agent needs human input
                logger.info(f"Planner blocked: {agent_status.question}")
                workflow.update_state(WorkflowState.PLANNING_BLOCKED)
                workflow.set_blocked(
                    reason=agent_status.message or "Planner needs input",
                    question=agent_status.question,
                    options=agent_status.options
                )
                self._save_workflow(workflow)
                # Wait loop will pause until human responds

            elif status == "complete":
                # Planning complete
                logger.info(f"Planning complete: {agent_status.output_file}")
                workflow.update_state(WorkflowState.PLANNED)
                workflow.plan_file_path = agent_status.output_file
                self._save_workflow(workflow)

                # No need to stop container - same container continues to execution
                # Start execution phase
                self._run_execution_phase(workflow)
                break

            elif status == "error":
                logger.error(f"Planner error: {agent_status.message}")
                workflow.update_state(WorkflowState.FAILED, agent_status.message)
                self._save_workflow(workflow)
                break

            elif status == "exited":
                # Container exited - check if plan file was created
                plan_file = workflow_dir / "plan.md"
                if plan_file.exists():
                    logger.info("Planner exited but plan file exists")
                    workflow.update_state(WorkflowState.PLANNED)
                    workflow.plan_file_path = "plan.md"
                    self._save_workflow(workflow)

                    # Start execution
                    self._run_execution_phase(workflow)
                else:
                    logger.error("Planner exited without creating plan")
                    logs = self.docker_manager.get_container_logs(container_id, tail=50)
                    workflow.update_state(WorkflowState.FAILED, f"Planner failed. Logs:\n{logs}")
                    self._save_workflow(workflow)
                break

    def _run_execution_phase(self, workflow: Workflow) -> Workflow:
        """Run the execution phase of the workflow."""
        logger.info(f"Starting execution phase for {workflow.id}")

        workflow.update_state(WorkflowState.EXECUTING)
        self._save_workflow(workflow)

        # Load executor prompt template
        executor_prompt = self._get_executor_prompt(workflow)

        try:
            # Execute executor in the same container
            self.docker_manager.exec_agent_in_container(
                container_id=workflow.container_id,
                agent_type=workflow.executor_model,
                prompt=executor_prompt,
                detached=True
            )

            # Monitor execution phase
            self._monitor_execution(workflow)

        except Exception as e:
            logger.error(f"Execution phase failed: {e}")
            workflow.update_state(WorkflowState.FAILED, str(e))
            self._save_workflow(workflow)

        return workflow

    def _monitor_execution(self, workflow: Workflow):
        """Monitor execution phase and handle state transitions."""
        container_id = workflow.container_id
        workflow_dir = Path(workflow.workflow_dir)

        logger.info(f"Monitoring execution phase in container {container_id[:12]}")

        for status, agent_status in self.docker_manager.wait_for_container(
            container_id,
            check_interval=self.config.container_check_interval,
            workflow_dir=workflow_dir
        ):
            if status == "blocked":
                logger.info(f"Executor blocked: {agent_status.question}")
                workflow.update_state(WorkflowState.EXECUTION_BLOCKED)
                workflow.set_blocked(
                    reason=agent_status.message or "Executor needs input",
                    question=agent_status.question,
                    options=agent_status.options
                )
                self._save_workflow(workflow)

            elif status == "complete":
                logger.info("Execution complete")

                # If review is enabled, start review phase
                if self.config.review_enabled:
                    # Start review phase
                    self._run_review_phase(workflow)
                else:
                    # No review - create PR directly
                    pr_url = self._extract_pr_url(agent_status, container_id)

                    if pr_url:
                        workflow.update_state(WorkflowState.COMPLETED)
                        workflow.pr_url = pr_url
                        self._save_workflow(workflow)
                        self._update_linear_ticket(workflow)
                    else:
                        logger.warning("Execution complete but no PR URL found")
                        workflow.update_state(WorkflowState.COMPLETED)
                        self._save_workflow(workflow)

                    # Clean up container (workflow complete)
                    self.docker_manager.stop_container(container_id)
                    self.docker_manager.remove_container(container_id, force=True)
                    logger.info(f"Workflow container cleaned up")

                break

            elif status == "error":
                logger.error(f"Executor error: {agent_status.message}")
                workflow.update_state(WorkflowState.FAILED, agent_status.message)
                self._save_workflow(workflow)
                break

            elif status == "exited":
                # Check logs for PR URL
                logs = self.docker_manager.get_container_logs(container_id)
                pr_url = self._extract_pr_url_from_logs(logs)

                if pr_url:
                    logger.info(f"Found PR URL in logs: {pr_url}")
                    workflow.update_state(WorkflowState.COMPLETED)
                    workflow.pr_url = pr_url
                    self._update_linear_ticket(workflow)
                else:
                    logger.error("Executor exited without creating PR")
                    workflow.update_state(WorkflowState.FAILED, f"Executor failed. Logs:\n{logs[-1000:]}")

                self._save_workflow(workflow)
                break

    def _run_review_phase(self, workflow: Workflow) -> Workflow:
        """Run the review phase of the workflow."""
        logger.info(f"Starting review phase for {workflow.id}")

        workflow.update_state(WorkflowState.REVIEWING)
        workflow.review_iteration += 1
        self._save_workflow(workflow)

        # Load reviewer prompt template
        reviewer_prompt = self._get_reviewer_prompt(workflow)

        try:
            # Execute reviewer in the same container
            self.docker_manager.exec_agent_in_container(
                container_id=workflow.container_id,
                agent_type=workflow.review_model,
                prompt=reviewer_prompt,
                detached=True
            )

            # Monitor review phase
            self._monitor_review(workflow)

        except Exception as e:
            logger.error(f"Review phase failed: {e}")
            workflow.update_state(WorkflowState.FAILED, str(e))
            self._save_workflow(workflow)

        return workflow

    def _monitor_review(self, workflow: Workflow):
        """Monitor review phase and handle state transitions."""
        container_id = workflow.container_id
        workflow_dir = Path(workflow.workflow_dir)

        logger.info(f"Monitoring review phase in container {container_id[:12]}")

        for status, agent_status in self.docker_manager.wait_for_container(
            container_id,
            check_interval=self.config.container_check_interval,
            workflow_dir=workflow_dir
        ):
            if status == "blocked":
                logger.info(f"Reviewer blocked: {agent_status.question}")
                workflow.update_state(WorkflowState.REVIEW_BLOCKED)
                workflow.set_blocked(
                    reason=agent_status.message or "Reviewer needs input",
                    question=agent_status.question,
                    options=agent_status.options
                )
                self._save_workflow(workflow)

            elif status == "complete":
                # Check agent status for review result
                if agent_status.message and "needs_rework" in agent_status.message.lower():
                    # Review found issues - send back to executor
                    logger.info("Review found issues - sending back to executor")

                    # Load feedback
                    feedback_file = workflow_dir / ".review-feedback.json"
                    if feedback_file.exists():
                        with open(feedback_file, 'r') as f:
                            feedback_data = json.load(f)
                            workflow.review_feedback = json.dumps(feedback_data, indent=2)

                    # Check if we've hit max iterations
                    if workflow.review_iteration >= workflow.max_review_iterations:
                        logger.warning(f"Max review iterations ({workflow.max_review_iterations}) reached")
                        workflow.update_state(WorkflowState.REVIEW_BLOCKED)
                        workflow.set_blocked(
                            reason=f"Max review iterations reached",
                            question=f"Review has failed {workflow.review_iteration} times. How should we proceed?",
                            options=["Approve and create PR anyway", "Cancel workflow", "Manual intervention needed"]
                        )
                        self._save_workflow(workflow)
                    else:
                        # Send back to executor for fixes
                        workflow.update_state(WorkflowState.NEEDS_REWORK)
                        self._save_workflow(workflow)

                        # Run executor again with feedback
                        self._run_execution_with_feedback(workflow)

                else:
                    # Review approved - create PR
                    logger.info("Review approved - creating PR")
                    self._create_pr_and_complete(workflow)

                break

            elif status == "error":
                logger.error(f"Reviewer error: {agent_status.message}")
                workflow.update_state(WorkflowState.FAILED, agent_status.message)
                self._save_workflow(workflow)
                break

            elif status == "exited":
                # Check if review passed or failed
                feedback_file = workflow_dir / ".review-feedback.json"
                if feedback_file.exists():
                    # Issues found
                    logger.info("Review found issues")
                    if workflow.review_iteration >= workflow.max_review_iterations:
                        workflow.update_state(WorkflowState.REVIEW_BLOCKED)
                        workflow.set_blocked(
                            reason="Max review iterations reached",
                            question="Continue anyway or cancel?",
                            options=["Approve", "Cancel"]
                        )
                    else:
                        workflow.update_state(WorkflowState.NEEDS_REWORK)
                        self._run_execution_with_feedback(workflow)
                else:
                    # Approved
                    logger.info("Review approved")
                    self._create_pr_and_complete(workflow)

                self._save_workflow(workflow)
                break

    def _run_execution_with_feedback(self, workflow: Workflow):
        """Re-run executor with review feedback."""
        logger.info(f"Re-running executor with review feedback (iteration {workflow.review_iteration})")

        # Update executor prompt to include feedback
        executor_prompt = self._get_executor_prompt(workflow, with_feedback=True)

        try:
            # Execute executor again
            self.docker_manager.exec_agent_in_container(
                container_id=workflow.container_id,
                agent_type=workflow.executor_model,
                prompt=executor_prompt,
                detached=True
            )

            # Update state back to executing
            workflow.update_state(WorkflowState.EXECUTING)
            self._save_workflow(workflow)

            # Monitor execution (will trigger review again when complete)
            self._monitor_execution(workflow)

        except Exception as e:
            logger.error(f"Execution with feedback failed: {e}")
            workflow.update_state(WorkflowState.FAILED, str(e))
            self._save_workflow(workflow)

    def _create_pr_and_complete(self, workflow: Workflow):
        """Create PR and mark workflow as complete."""
        container_id = workflow.container_id
        workflow_dir = Path(workflow.workflow_dir)

        # Load PR creation prompt (uses Claude for detailed descriptions)
        pr_prompt = self._get_pr_creation_prompt(workflow)

        try:
            # Use executor agent (Claude) to create PR with detailed description
            self.docker_manager.exec_agent_in_container(
                container_id=workflow.container_id,
                agent_type=workflow.executor_model,  # Claude writes best PR descriptions
                prompt=pr_prompt,
                detached=True
            )

            # Wait a bit for PR creation
            time.sleep(5)

            # Get logs to find PR URL
            logs = self.docker_manager.get_container_logs(container_id)
            pr_url = self._extract_pr_url_from_logs(logs)

            if pr_url:
                workflow.update_state(WorkflowState.COMPLETED)
                workflow.pr_url = pr_url
                self._update_linear_ticket(workflow)
            else:
                logger.warning("PR creation complete but no PR URL found")
                workflow.update_state(WorkflowState.COMPLETED)

            self._save_workflow(workflow)

            # Clean up container
            self.docker_manager.stop_container(container_id)
            self.docker_manager.remove_container(container_id, force=True)
            logger.info(f"Workflow container cleaned up")

        except Exception as e:
            logger.error(f"PR creation failed: {e}")
            workflow.update_state(WorkflowState.FAILED, str(e))
            self._save_workflow(workflow)

    def respond_to_workflow(self, workflow: Workflow, response: str) -> Workflow:
        """Provide human response to a blocked workflow."""
        if not workflow.is_blocked():
            raise ValueError(f"Workflow {workflow.id} is not blocked")

        logger.info(f"Responding to blocked workflow {workflow.id}: {response}")

        workflow_dir = Path(workflow.workflow_dir)

        # Write response for agent
        self.docker_manager.write_agent_response(workflow_dir, response)

        # Update workflow
        workflow.set_unblocked(response)

        # Resume appropriate state
        if workflow.state == WorkflowState.PLANNING_BLOCKED:
            workflow.update_state(WorkflowState.PLANNING)
        elif workflow.state == WorkflowState.EXECUTION_BLOCKED:
            workflow.update_state(WorkflowState.EXECUTING)

        self._save_workflow(workflow)

        return workflow

    def _save_ticket_details(self, workflow: Workflow, issue: Dict[str, Any]):
        """Save ticket details and attachments to workflow directory."""
        workflow_dir = Path(workflow.workflow_dir)

        # Download attachments
        attachments_dir = workflow_dir / "attachments"
        downloaded_files = self.linear_client.download_attachments(issue, attachments_dir)

        # Format and save ticket as markdown
        ticket_md = self.linear_client.format_issue_as_markdown(issue, attachments_dir)
        ticket_file = workflow_dir / "linear-ticket.md"

        with open(ticket_file, 'w') as f:
            f.write(ticket_md)

        logger.info(f"Saved ticket details to {ticket_file}")

        # Create a screenshots manifest for easy agent reference
        if downloaded_files:
            self._create_screenshots_manifest(workflow_dir, downloaded_files)

    def _create_screenshots_manifest(self, workflow_dir: Path, downloaded_files: list):
        """Create a manifest of screenshots for agents to easily reference."""
        manifest_file = workflow_dir / "SCREENSHOTS.md"

        lines = [
            "# Screenshots & Attachments",
            "",
            "This ticket includes visual references. **IMPORTANT: Use the Read tool to view each image below.**",
            "",
        ]

        image_extensions = ('.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg')

        for file_path in downloaded_files:
            file_name = Path(file_path).name
            rel_path = f"./attachments/{file_name}"

            if any(file_name.lower().endswith(ext) for ext in image_extensions):
                lines.append(f"## {file_name}")
                lines.append(f"**File:** `{rel_path}`")
                lines.append(f"**To view:** Use Read tool on `{rel_path}`")
                lines.append(f"![{file_name}]({rel_path})")
                lines.append("")

        lines.extend([
            "",
            "---",
            "**Agent Instructions:**",
            "1. Use the Read tool to view each image file listed above",
            "2. Pay careful attention to UI layouts, colors, spacing, and interactions",
            "3. Ensure your implementation matches the visual requirements shown",
        ])

        with open(manifest_file, 'w') as f:
            f.write("\n".join(lines))

        logger.info(f"Created screenshots manifest: {manifest_file}")

    def _save_workflow(self, workflow: Workflow):
        """Save workflow metadata to disk."""
        workflow_dir = Path(workflow.workflow_dir)
        metadata_file = workflow_dir / "metadata.json"

        with open(metadata_file, 'w') as f:
            json.dump(workflow.to_dict(), f, indent=2)

    def load_workflow(self, workflow_id: str) -> Optional[Workflow]:
        """Load workflow from disk."""
        workflow_dir = self.workflows_dir / workflow_id
        metadata_file = workflow_dir / "metadata.json"

        if not metadata_file.exists():
            return None

        with open(metadata_file, 'r') as f:
            data = json.load(f)
            return Workflow.from_dict(data)

    def list_workflows(self, state_filter: Optional[WorkflowState] = None) -> List[Workflow]:
        """List all workflows, optionally filtered by state."""
        workflows = []

        for workflow_dir in self.workflows_dir.iterdir():
            if not workflow_dir.is_dir():
                continue

            workflow = self.load_workflow(workflow_dir.name)
            if workflow:
                if state_filter is None or workflow.state == state_filter:
                    workflows.append(workflow)

        # Sort by updated_at descending
        workflows.sort(key=lambda w: w.updated_at, reverse=True)
        return workflows

    def _generate_branch_name(self, issue: Dict[str, Any]) -> str:
        """Generate a git branch name from issue."""
        identifier = issue['identifier']
        title = issue['title']

        # Sanitize title for branch name
        title_part = title.lower()
        title_part = ''.join(c if c.isalnum() or c in (' ', '-') else '' for c in title_part)
        title_part = '-'.join(title_part.split())[:50]

        return f"feature/{identifier}-{title_part}"

    def _get_planner_prompt(self, workflow: Workflow) -> str:
        """Generate prompt for planner agent."""
        # Load template
        template_path = Path(__file__).parent.parent / "templates" / "planner_prompt.txt"

        if template_path.exists():
            with open(template_path, 'r') as f:
                template = f.read()
        else:
            template = """You are a planning agent. Read the Linear ticket at /workspace/linear-ticket.md and create a detailed implementation plan.

Save your plan to /workspace/plan.md

When complete, create /workspace/.workflow-status.json:
{
  "status": "complete",
  "output_file": "plan.md"
}

If you need human input, create /workspace/.workflow-status.json:
{
  "status": "blocked",
  "question": "Your question here",
  "options": ["Option 1", "Option 2"]
}
"""

        return template

    def _get_executor_prompt(self, workflow: Workflow, with_feedback: bool = False) -> str:
        """Generate prompt for executor agent."""
        template_path = Path(__file__).parent.parent / "templates" / "executor_prompt.txt"

        if template_path.exists():
            with open(template_path, 'r') as f:
                template = f.read()
        else:
            template = """You are an execution agent. Implement the plan at /workspace/plan.md

Follow these steps:
1. Read the plan carefully
2. Implement all changes
3. When complete, create /workspace/.workflow-status.json:
{
  "status": "complete",
  "message": "Implementation complete"
}

If you need human input, create /workspace/.workflow-status.json:
{
  "status": "blocked",
  "question": "Your question here"
}
"""

        # Add feedback if this is a rework
        if with_feedback and workflow.review_feedback:
            feedback_note = f"\n\n## REVIEW FEEDBACK - NEEDS REWORK\n\nThe code reviewer found issues that need to be fixed:\n\n{workflow.review_feedback}\n\nPlease address all the issues mentioned above and update your implementation accordingly.\n"
            template = feedback_note + template

        return template

    def _get_reviewer_prompt(self, workflow: Workflow) -> str:
        """Generate prompt for reviewer agent."""
        template_path = Path(__file__).parent.parent / "templates" / "reviewer_prompt.txt"

        if template_path.exists():
            with open(template_path, 'r') as f:
                template = f.read()
        else:
            template = """You are a code review agent. Review the implementation against the plan.

Check for:
- Missing features
- Bugs or logic errors
- Security issues
- Code quality

If APPROVED, create /workspace/.workflow-status.json:
{
  "status": "complete",
  "message": "Code review passed",
  "review_result": "approved"
}

If NEEDS_REWORK, create /workspace/.review-feedback.json with issues, then:
{
  "status": "needs_rework",
  "message": "Found issues that need to be fixed"
}
"""

        # Inject iteration info
        template = template.format(
            iteration=workflow.review_iteration,
            max_iterations=workflow.max_review_iterations
        )

        return template

    def _get_pr_creation_prompt(self, workflow: Workflow) -> str:
        """Generate prompt for PR creation (uses executor agent - Claude)."""
        template_path = Path(__file__).parent.parent / "templates" / "pr_creation_prompt.txt"

        if template_path.exists():
            with open(template_path, 'r') as f:
                template = f.read()
        else:
            template = """Create a pull request with a detailed description.

Review the implementation:
- Check git diff for changes
- Read /workspace/plan.md for context
- Read /workspace/linear-ticket.md for requirements

Create a comprehensive PR description with:
1. Summary (what was implemented)
2. Changes (key files and features)
3. Testing (how it was verified)
4. Related (link to Linear ticket)

Use `gh pr create` to create the PR.

Signal completion with .workflow-status.json containing the PR URL.
"""

        return template

    def _extract_pr_url(self, agent_status, container_id: str) -> Optional[str]:
        """Extract PR URL from agent status or container logs."""
        if agent_status and agent_status.message:
            # Look for PR URL in message
            import re
            match = re.search(r'https://github\.com/[^/]+/[^/]+/pull/\d+', agent_status.message)
            if match:
                return match.group(0)

        # Check logs
        logs = self.docker_manager.get_container_logs(container_id)
        return self._extract_pr_url_from_logs(logs)

    def _extract_pr_url_from_logs(self, logs: str) -> Optional[str]:
        """Extract PR URL from container logs."""
        import re
        match = re.search(r'https://github\.com/[^/]+/[^/]+/pull/\d+', logs)
        if match:
            return match.group(0)
        return None

    def _update_linear_ticket(self, workflow: Workflow):
        """Update Linear ticket with PR link and status."""
        if not workflow.pr_url:
            return

        try:
            # Add comment with PR link
            comment_body = f"✅ PR created: {workflow.pr_url}\n\nGenerated by workflow orchestrator"
            self.linear_client.create_comment(workflow.linear_ticket_id, comment_body)

            # Try to move to "In Review" state
            self.linear_client.update_issue_state(workflow.linear_ticket_id, "In Review")

            logger.info(f"Updated Linear ticket {workflow.linear_ticket_id}")

        except Exception as e:
            logger.error(f"Failed to update Linear ticket: {e}")
