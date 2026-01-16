FROM node:20-slim

# Accept build arguments for user ID and group ID
ARG USER_ID=1000
ARG GROUP_ID=1000

# Install system dependencies including Git, zsh, and GitHub CLI
RUN apt-get update && apt-get install -y \
    git \
    curl \
    ca-certificates \
    zsh \
    wget \
    python3 \
    python3-pip \
    python3-venv \
    python3-psycopg2 \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Create a default virtual environment for pip installs
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install --no-cache-dir psycopg2-binary requests

# Install Poetry for all users
ENV POETRY_HOME="/opt/poetry"
ENV PATH="/opt/poetry/bin:$PATH"
RUN curl -sSL https://install.python-poetry.org | python3 - && \
    chmod -R a+rx /opt/poetry && \
    ln -s /opt/poetry/bin/poetry /usr/local/bin/poetry && \
    poetry config virtualenvs.in-project true

# Install GitHub CLI (detect architecture)
RUN ARCH=$(dpkg --print-architecture) && \
    wget https://github.com/cli/cli/releases/download/v2.40.0/gh_2.40.0_linux_${ARCH}.deb && \
    dpkg -i gh_2.40.0_linux_${ARCH}.deb && \
    rm gh_2.40.0_linux_${ARCH}.deb

# Install Go (detect architecture)
RUN ARCH=$(dpkg --print-architecture) && \
    GO_ARCH=$(case ${ARCH} in amd64) echo "amd64" ;; arm64) echo "arm64" ;; *) echo "amd64" ;; esac) && \
    wget https://go.dev/dl/go1.23.5.linux-${GO_ARCH}.tar.gz && \
    tar -C /usr/local -xzf go1.23.5.linux-${GO_ARCH}.tar.gz && \
    rm go1.23.5.linux-${GO_ARCH}.tar.gz

# Set up Go environment variables
ENV PATH="/usr/local/go/bin:${PATH}" \
    GOPATH="/home/node/go" \
    GOBIN="/home/node/go/bin"

# Install Claude Code CLI globally (pinned to latest stable version)
RUN npm install -g @anthropic-ai/claude-code@2.1.1

# Install OpenAI Codex CLI globally
RUN npm install -g @openai/codex

# Modify the existing node user to match host UID/GID
# Handle case where GID already exists by using existing group or creating new one
RUN if getent group ${GROUP_ID} > /dev/null 2>&1; then \
        GROUP_NAME=$(getent group ${GROUP_ID} | cut -d: -f1); \
        usermod -u ${USER_ID} -g ${GROUP_NAME} node; \
    else \
        groupmod -g ${GROUP_ID} node && \
        usermod -u ${USER_ID} node; \
    fi && \
    chown -R ${USER_ID}:${GROUP_ID} /home/node

# Create directories and set permissions
RUN mkdir -p /home/node/.claude /home/node/.codex /workspace /home/node/go/bin && \
    chown -R node:node /home/node/.claude /home/node/.codex /workspace /home/node/go

# Copy Claude Code credentials from build context
# This file is created by build.sh from macOS Keychain
# Run build.sh to extract credentials before building
COPY .build-temp/.credentials.json /home/node/.claude/.credentials.json
RUN chmod 600 /home/node/.claude/.credentials.json && \
    chown node:node /home/node/.claude/.credentials.json

# Copy Codex credentials from build context (if they exist)
# These files are created by build.sh from ~/.codex
# The wildcard allows this to succeed even if .codex doesn't exist
COPY .build-temp/.codex /home/node/.codex/
RUN if [ -f /home/node/.codex/auth.json ]; then \
        chmod 600 /home/node/.codex/auth.json; \
    fi && \
    chown -R node:node /home/node/.codex

# Set up working directory
WORKDIR /workspace

# Configure Git and set zsh as default shell for node user
USER node
RUN git config --global init.defaultBranch main
USER root
RUN chsh -s /bin/zsh node

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Environment variables for LLM CLI configuration
ENV CLAUDE_SKIP_PERMISSIONS="" \
    LLM_TYPE="claude" \
    HOME=/home/node \
    PATH="/opt/venv/bin:/home/node/go/bin:/usr/local/go/bin:${PATH}"

# Switch to non-root user (use existing 'node' user)
USER node

# Set entrypoint
ENTRYPOINT ["/entrypoint.sh"]

# Default command (can be "claude" or "codex")
CMD ["llm"]
