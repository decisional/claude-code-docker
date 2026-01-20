"""Linear API client wrapper."""

import requests
from typing import Optional, Dict, Any
from pathlib import Path
import logging

logger = logging.getLogger(__name__)


class LinearClient:
    """Client for interacting with Linear API."""

    def __init__(self, api_key: str):
        self.api_key = api_key
        self.base_url = "https://api.linear.app/graphql"
        self.headers = {
            "Authorization": api_key,
            "Content-Type": "application/json"
        }

    def _execute_query(self, query: str, variables: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Execute a GraphQL query."""
        payload = {"query": query}
        if variables:
            payload["variables"] = variables

        response = requests.post(self.base_url, json=payload, headers=self.headers)
        response.raise_for_status()

        data = response.json()
        if "errors" in data:
            raise Exception(f"Linear API error: {data['errors']}")

        return data.get("data", {})

    def get_issue(self, issue_id: str) -> Dict[str, Any]:
        """Fetch issue details by ID or identifier (e.g., 'DEC-123')."""
        query = """
        query GetIssue($id: String!) {
          issue(id: $id) {
            id
            identifier
            title
            description
            state { name type }
            assignee { name email }
            team { name key }
            project { name }
            labels { nodes { name color } }
            attachments { nodes {
              id
              title
              url
              subtitle
              metadata
            }}
            createdAt
            updatedAt
            url
          }
        }
        """

        data = self._execute_query(query, {"id": issue_id})
        issue = data.get("issue")

        if not issue:
            raise ValueError(f"Issue not found: {issue_id}")

        return issue

    def create_comment(self, issue_id: str, body: str) -> Dict[str, Any]:
        """Create a comment on an issue."""
        mutation = """
        mutation CreateComment($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) {
            success
            comment {
              id
              body
              createdAt
            }
          }
        }
        """

        data = self._execute_query(mutation, {"issueId": issue_id, "body": body})
        return data.get("commentCreate", {})

    def update_issue_state(self, issue_id: str, state_name: str) -> Dict[str, Any]:
        """Update issue state (e.g., 'In Progress', 'In Review')."""
        # First, get available states for the team
        issue = self.get_issue(issue_id)
        team_key = issue.get("team", {}).get("key")

        # Find state ID by name
        query = """
        query GetStates($teamKey: String!) {
          team(id: $teamKey) {
            states { nodes { id name type } }
          }
        }
        """

        data = self._execute_query(query, {"teamKey": team_key})
        states = data.get("team", {}).get("states", {}).get("nodes", [])

        state_id = None
        for state in states:
            if state["name"].lower() == state_name.lower():
                state_id = state["id"]
                break

        if not state_id:
            logger.warning(f"State '{state_name}' not found, skipping state update")
            return {}

        # Update issue state
        mutation = """
        mutation UpdateIssue($issueId: String!, $stateId: String!) {
          issueUpdate(id: $issueId, input: { stateId: $stateId }) {
            success
            issue {
              id
              state { name type }
            }
          }
        }
        """

        data = self._execute_query(mutation, {"issueId": issue_id, "stateId": state_id})
        return data.get("issueUpdate", {})

    def download_attachments(self, issue: Dict[str, Any], output_dir: Path) -> list[str]:
        """Download issue attachments (screenshots, etc.) to output directory."""
        output_dir.mkdir(parents=True, exist_ok=True)

        attachments = issue.get("attachments", {}).get("nodes", [])
        downloaded = []

        for attachment in attachments:
            url = attachment.get("url")
            title = attachment.get("title", "attachment")

            if not url:
                continue

            try:
                # Download file
                response = requests.get(url)
                response.raise_for_status()

                # Determine filename
                filename = title
                if not filename:
                    filename = url.split("/")[-1].split("?")[0]

                file_path = output_dir / filename

                with open(file_path, 'wb') as f:
                    f.write(response.content)

                downloaded.append(str(file_path))
                logger.info(f"Downloaded attachment: {filename}")

            except Exception as e:
                logger.error(f"Failed to download attachment {title}: {e}")

        return downloaded

    def format_issue_as_markdown(self, issue: Dict[str, Any], attachments_dir: Optional[Path] = None) -> str:
        """Format issue as markdown for agents to read."""
        lines = []

        lines.append(f"# {issue['identifier']}: {issue['title']}\n")
        lines.append(f"**URL:** {issue['url']}\n")

        # Metadata
        if issue.get('assignee'):
            lines.append(f"**Assignee:** {issue['assignee']['name']} ({issue['assignee']['email']})")

        if issue.get('project'):
            lines.append(f"**Project:** {issue['project']['name']}")

        if issue.get('team'):
            lines.append(f"**Team:** {issue['team']['name']}")

        if issue.get('state'):
            lines.append(f"**State:** {issue['state']['name']} ({issue['state']['type']})")

        if issue.get('labels', {}).get('nodes'):
            labels = [label['name'] for label in issue['labels']['nodes']]
            lines.append(f"**Labels:** {', '.join(labels)}")

        lines.append("")

        # Description
        lines.append("## Description\n")
        if issue.get('description'):
            lines.append(issue['description'])
        else:
            lines.append("_No description provided_")

        lines.append("")

        # Attachments - embed images directly in markdown
        attachments = issue.get("attachments", {}).get("nodes", [])
        if attachments:
            lines.append("## Attachments & Screenshots\n")
            for attachment in attachments:
                title = attachment.get("title", "Untitled")
                url = attachment.get("url", "")

                if attachments_dir:
                    filename = title if title else url.split("/")[-1].split("?")[0]
                    local_path = f"./attachments/{filename}"

                    # Check if it's an image file
                    image_extensions = ('.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg')
                    if any(filename.lower().endswith(ext) for ext in image_extensions):
                        # Embed image inline so agents can see it
                        lines.append(f"### {title}\n")
                        lines.append(f"![{title}]({local_path})\n")
                        lines.append(f"_Image file: `{local_path}`_\n")
                    else:
                        # Non-image attachment
                        lines.append(f"- **{title}**: [View file]({local_path}) | [Original]({url})")
                else:
                    lines.append(f"- **{title}**: {url}")

            lines.append("")
            lines.append("**Note for agents:** Screenshots are embedded above. You can also read them directly using the file paths shown.")

        return "\n".join(lines)
