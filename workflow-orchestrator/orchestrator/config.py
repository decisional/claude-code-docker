"""Configuration management for workflow orchestrator."""

import os
import yaml
from pathlib import Path
from typing import Optional
from dataclasses import dataclass


@dataclass
class OrchestratorConfig:
    """Configuration for the workflow orchestrator."""

    # Linear API
    linear_api_key: str
    linear_team_id: Optional[str] = None

    # Git repository
    repo_url: str = ""
    base_branch: str = "main"

    # Model selection
    default_planner: str = "codex"  # "codex" or "claude"
    default_executor: str = "claude"  # "claude" or "codex"

    # Docker
    docker_image: str = "llm-docker-claude-code:latest"
    workspace_base: str = "/workspace"

    # Paths
    workflows_dir: str = "./workflows"
    db_path: str = "./workflow.db"

    # Timeouts (minutes)
    planning_timeout: int = 30
    execution_timeout: int = 120
    container_check_interval: int = 5  # seconds

    # Notifications (optional)
    slack_webhook_url: Optional[str] = None
    notify_on_block: bool = True
    notify_on_complete: bool = True

    # GitHub (for PR creation)
    github_token: Optional[str] = None

    @classmethod
    def from_yaml(cls, config_path: str) -> 'OrchestratorConfig':
        """Load configuration from YAML file."""
        with open(config_path, 'r') as f:
            data = yaml.safe_load(f)

        # Override with environment variables
        data['linear_api_key'] = os.getenv('LINEAR_API_KEY', data.get('linear_api_key', ''))
        data['github_token'] = os.getenv('GITHUB_TOKEN', data.get('github_token'))
        data['slack_webhook_url'] = os.getenv('SLACK_WEBHOOK_URL', data.get('slack_webhook_url'))

        return cls(**data)

    @classmethod
    def from_env(cls) -> 'OrchestratorConfig':
        """Create configuration from environment variables."""
        return cls(
            linear_api_key=os.getenv('LINEAR_API_KEY', ''),
            linear_team_id=os.getenv('LINEAR_TEAM_ID'),
            repo_url=os.getenv('GIT_REPO_URL', ''),
            base_branch=os.getenv('GIT_BASE_BRANCH', 'main'),
            default_planner=os.getenv('DEFAULT_PLANNER', 'codex'),
            default_executor=os.getenv('DEFAULT_EXECUTOR', 'claude'),
            github_token=os.getenv('GITHUB_TOKEN'),
            slack_webhook_url=os.getenv('SLACK_WEBHOOK_URL'),
        )

    def validate(self) -> list[str]:
        """Validate configuration and return list of errors."""
        errors = []

        if not self.linear_api_key:
            errors.append("LINEAR_API_KEY is required")

        if not self.repo_url:
            errors.append("repo_url (GIT_REPO_URL) is required")

        if self.default_planner not in ['claude', 'codex']:
            errors.append(f"Invalid default_planner: {self.default_planner}")

        if self.default_executor not in ['claude', 'codex']:
            errors.append(f"Invalid default_executor: {self.default_executor}")

        return errors


def load_config(config_path: Optional[str] = None) -> OrchestratorConfig:
    """Load configuration from file or environment."""
    if config_path and Path(config_path).exists():
        return OrchestratorConfig.from_yaml(config_path)
    else:
        return OrchestratorConfig.from_env()
