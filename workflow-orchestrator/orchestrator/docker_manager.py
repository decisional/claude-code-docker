"""Docker container management for workflow agents."""

import subprocess
import logging
import time
import json
from pathlib import Path
from typing import Optional, Dict, Any
from .models import AgentType, AgentStatus

logger = logging.getLogger(__name__)


class DockerManager:
    """Manages Docker containers for planner and executor agents."""

    def __init__(self, docker_image: str, workspace_base: str = "/workspace"):
        self.docker_image = docker_image
        self.workspace_base = workspace_base

    def start_agent_container(
        self,
        container_name: str,
        agent_type: AgentType,
        workflow_dir: Path,
        repo_url: str,
        branch_name: str,
        prompt: str,
        github_token: Optional[str] = None
    ) -> str:
        """
        Start a Docker container for a planner or executor agent.

        Returns:
            Container ID
        """
        # Prepare environment variables
        env_vars = {
            "LLM_TYPE": agent_type.value,
            "GIT_REPO_URL": repo_url,
            "GIT_BRANCH": branch_name,
            "CLAUDE_SKIP_PERMISSIONS": "true",
            "CODEX_YOLO": "true",
            "CODEX_APPROVAL_POLICY": "yolo"
        }

        if github_token:
            env_vars["GITHUB_TOKEN"] = github_token

        # Build docker run command
        cmd = [
            "docker", "run",
            "-d",  # Detached mode
            "--name", container_name,
            "-w", self.workspace_base,
        ]

        # Add environment variables
        for key, value in env_vars.items():
            cmd.extend(["-e", f"{key}={value}"])

        # Mount workflow directory
        cmd.extend([
            "-v", f"{workflow_dir.absolute()}:{self.workspace_base}",
            "-v", f"{Path.cwd()}/claude-data:/home/node/.claude",
            "-v", f"{Path.cwd()}/codex-data:/home/node/.codex",
            "-v", f"{Path.cwd()}/git-data/.gitconfig:/home/node/.gitconfig",
            "-v", f"{Path.cwd()}/git-data/.ssh:/home/node/.ssh",
            "-v", f"{Path.cwd()}/git-data/.config/gh:/home/node/.config/gh",
        ])

        # Add image and command
        cmd.extend([
            self.docker_image,
            agent_type.value,  # "claude" or "codex"
            prompt
        ])

        logger.info(f"Starting {agent_type.value} container: {container_name}")
        logger.debug(f"Command: {' '.join(cmd)}")

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            container_id = result.stdout.strip()
            logger.info(f"Container started: {container_id[:12]}")
            return container_id
        except subprocess.CalledProcessError as e:
            logger.error(f"Failed to start container: {e.stderr}")
            raise

    def get_container_logs(self, container_id: str, tail: Optional[int] = None) -> str:
        """Get logs from a container."""
        cmd = ["docker", "logs", container_id]

        if tail:
            cmd.extend(["--tail", str(tail)])

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            return result.stdout
        except subprocess.CalledProcessError as e:
            logger.error(f"Failed to get logs: {e.stderr}")
            return ""

    def follow_logs(self, container_id: str, callback):
        """Follow container logs in real-time."""
        cmd = ["docker", "logs", "-f", container_id]

        try:
            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1
            )

            for line in process.stdout:
                callback(line.rstrip())

        except Exception as e:
            logger.error(f"Error following logs: {e}")

    def is_container_running(self, container_id: str) -> bool:
        """Check if container is still running."""
        cmd = ["docker", "inspect", "-f", "{{.State.Running}}", container_id]

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            return result.stdout.strip().lower() == "true"
        except subprocess.CalledProcessError:
            return False

    def get_container_status(self, container_id: str) -> Optional[str]:
        """Get container status (running, exited, etc.)."""
        cmd = ["docker", "inspect", "-f", "{{.State.Status}}", container_id]

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            return result.stdout.strip()
        except subprocess.CalledProcessError:
            return None

    def get_container_exit_code(self, container_id: str) -> Optional[int]:
        """Get container exit code."""
        cmd = ["docker", "inspect", "-f", "{{.State.ExitCode}}", container_id]

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            return int(result.stdout.strip())
        except (subprocess.CalledProcessError, ValueError):
            return None

    def stop_container(self, container_id: str, timeout: int = 10):
        """Stop a running container."""
        cmd = ["docker", "stop", "-t", str(timeout), container_id]

        try:
            subprocess.run(cmd, capture_output=True, text=True, check=True)
            logger.info(f"Container stopped: {container_id[:12]}")
        except subprocess.CalledProcessError as e:
            logger.error(f"Failed to stop container: {e.stderr}")

    def remove_container(self, container_id: str, force: bool = False):
        """Remove a container."""
        cmd = ["docker", "rm"]

        if force:
            cmd.append("-f")

        cmd.append(container_id)

        try:
            subprocess.run(cmd, capture_output=True, text=True, check=True)
            logger.info(f"Container removed: {container_id[:12]}")
        except subprocess.CalledProcessError as e:
            logger.error(f"Failed to remove container: {e.stderr}")

    def check_agent_status(self, workflow_dir: Path) -> Optional[AgentStatus]:
        """
        Check for agent status file written by the container.

        Agents should write status to /workspace/.workflow-status.json with format:
        {
            "status": "working" | "blocked" | "complete" | "error",
            "message": "Optional message",
            "question": "Question for human (if blocked)",
            "options": ["Option 1", "Option 2"] (if blocked),
            "output_file": "path/to/output.md" (if complete)
        }
        """
        status_file = workflow_dir / ".workflow-status.json"

        if not status_file.exists():
            return None

        try:
            with open(status_file, 'r') as f:
                data = json.load(f)
                return AgentStatus.from_dict(data)
        except (json.JSONDecodeError, Exception) as e:
            logger.error(f"Failed to parse agent status: {e}")
            return None

    def write_agent_response(self, workflow_dir: Path, response: str):
        """
        Write human response for agent to read.

        Agents should watch for /workspace/.workflow-resume.json with format:
        {
            "response": "Human's answer to the question"
        }
        """
        resume_file = workflow_dir / ".workflow-resume.json"

        data = {"response": response}

        with open(resume_file, 'w') as f:
            json.dump(data, f, indent=2)

        logger.info(f"Wrote resume file with response: {response}")

    def clear_status_files(self, workflow_dir: Path):
        """Clear agent status and resume files."""
        status_file = workflow_dir / ".workflow-status.json"
        resume_file = workflow_dir / ".workflow-resume.json"

        if status_file.exists():
            status_file.unlink()

        if resume_file.exists():
            resume_file.unlink()

    def wait_for_container(self, container_id: str, check_interval: int = 5, workflow_dir: Optional[Path] = None):
        """
        Wait for container to complete or signal status.

        Yields:
            Tuple of (status, agent_status)
            - status: "running", "exited", "blocked", "complete"
            - agent_status: AgentStatus object if available
        """
        while True:
            # Check container state
            if not self.is_container_running(container_id):
                exit_code = self.get_container_exit_code(container_id)
                logger.info(f"Container exited with code {exit_code}")
                yield ("exited", None)
                break

            # Check for agent status file
            if workflow_dir:
                agent_status = self.check_agent_status(workflow_dir)

                if agent_status:
                    if agent_status.status == "blocked":
                        logger.info(f"Agent is blocked: {agent_status.question}")
                        yield ("blocked", agent_status)
                        # Wait for resume signal before continuing
                        self._wait_for_resume(workflow_dir)

                    elif agent_status.status == "complete":
                        logger.info(f"Agent completed: {agent_status.output_file}")
                        yield ("complete", agent_status)
                        break

                    elif agent_status.status == "error":
                        logger.error(f"Agent error: {agent_status.message}")
                        yield ("error", agent_status)
                        break

            # Still running
            yield ("running", None)
            time.sleep(check_interval)

    def _wait_for_resume(self, workflow_dir: Path, check_interval: int = 2):
        """Wait for human to provide response via resume file."""
        resume_file = workflow_dir / ".workflow-resume.json"

        logger.info("Waiting for human response...")

        while not resume_file.exists():
            time.sleep(check_interval)

        logger.info("Resume file detected, agent can continue")
