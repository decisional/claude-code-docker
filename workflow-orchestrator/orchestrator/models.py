"""Data models for workflow orchestration."""

from enum import Enum
from datetime import datetime
from typing import Optional
from dataclasses import dataclass, field, asdict
import json


class WorkflowState(Enum):
    """Workflow state machine states."""
    PENDING = "pending"
    FETCHING_TICKET = "fetching_ticket"
    PLANNING = "planning"
    PLANNING_BLOCKED = "planning_blocked"
    PLANNED = "planned"
    EXECUTING = "executing"
    EXECUTION_BLOCKED = "execution_blocked"
    CREATING_PR = "creating_pr"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class AgentType(Enum):
    """LLM agent types."""
    CLAUDE = "claude"
    CODEX = "codex"


@dataclass
class BlockInfo:
    """Information about a workflow block (waiting for human input)."""
    reason: str
    question: str
    options: Optional[list[str]] = None
    blocked_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> 'BlockInfo':
        return cls(**data)


@dataclass
class Workflow:
    """Represents a single workflow from Linear ticket to PR."""

    # Identity
    id: str
    linear_ticket_id: str

    # State
    state: WorkflowState
    created_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())
    updated_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())

    # Configuration
    planner_model: AgentType = AgentType.CODEX
    executor_model: AgentType = AgentType.CLAUDE
    repo_url: str = ""
    base_branch: str = "main"
    branch_name: str = ""

    # Artifacts
    workflow_dir: str = ""
    plan_file_path: Optional[str] = None
    pr_url: Optional[str] = None
    pr_number: Optional[int] = None

    # Container tracking
    planner_container_id: Optional[str] = None
    executor_container_id: Optional[str] = None

    # Human-in-the-loop
    block_info: Optional[BlockInfo] = None
    human_response: Optional[str] = None

    # Error tracking
    error_message: Optional[str] = None
    retry_count: int = 0

    # Linear ticket metadata
    ticket_title: Optional[str] = None
    ticket_description: Optional[str] = None
    ticket_assignee: Optional[str] = None
    ticket_project: Optional[str] = None

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        data = asdict(self)
        data['state'] = self.state.value
        data['planner_model'] = self.planner_model.value
        data['executor_model'] = self.executor_model.value
        if self.block_info:
            data['block_info'] = self.block_info.to_dict()
        return data

    @classmethod
    def from_dict(cls, data: dict) -> 'Workflow':
        """Create from dictionary."""
        # Convert enums
        data['state'] = WorkflowState(data['state'])
        data['planner_model'] = AgentType(data['planner_model'])
        data['executor_model'] = AgentType(data['executor_model'])

        # Convert block_info
        if data.get('block_info'):
            data['block_info'] = BlockInfo.from_dict(data['block_info'])

        return cls(**data)

    def update_state(self, new_state: WorkflowState, error_message: Optional[str] = None):
        """Update workflow state."""
        self.state = new_state
        self.updated_at = datetime.utcnow().isoformat()
        if error_message:
            self.error_message = error_message

    def set_blocked(self, reason: str, question: str, options: Optional[list[str]] = None):
        """Mark workflow as blocked."""
        self.block_info = BlockInfo(reason=reason, question=question, options=options)
        self.human_response = None

    def set_unblocked(self, response: str):
        """Mark workflow as unblocked with human response."""
        self.human_response = response
        self.block_info = None

    def is_blocked(self) -> bool:
        """Check if workflow is currently blocked."""
        return self.state in [WorkflowState.PLANNING_BLOCKED, WorkflowState.EXECUTION_BLOCKED]

    def is_terminal(self) -> bool:
        """Check if workflow is in a terminal state."""
        return self.state in [WorkflowState.COMPLETED, WorkflowState.FAILED, WorkflowState.CANCELLED]


@dataclass
class AgentStatus:
    """Status information from an agent (planner or executor)."""
    status: str  # "working", "blocked", "complete", "error"
    message: Optional[str] = None
    question: Optional[str] = None
    options: Optional[list[str]] = None
    output_file: Optional[str] = None  # For "complete" status

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> 'AgentStatus':
        return cls(**data)

    @classmethod
    def from_file(cls, file_path: str) -> Optional['AgentStatus']:
        """Load agent status from JSON file."""
        try:
            with open(file_path, 'r') as f:
                data = json.load(f)
                return cls.from_dict(data)
        except (FileNotFoundError, json.JSONDecodeError):
            return None
