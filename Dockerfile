FROM node:20-slim

# Accept build arguments for user ID and group ID
ARG USER_ID=1000
ARG GROUP_ID=1000

# Install system dependencies including Git, zsh, jq, and GitHub CLI
RUN apt-get update && apt-get install -y \
    git \
    curl \
    ca-certificates \
    zsh \
    wget \
    jq \
    libpq-dev \
    postgresql-client \
    build-essential \
    zlib1g-dev \
    libncurses5-dev \
    libgdbm-dev \
    libnss3-dev \
    libssl-dev \
    libreadline-dev \
    libffi-dev \
    libsqlite3-dev \
    libbz2-dev \
    liblzma-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Python 3.12 from source
RUN wget https://www.python.org/ftp/python/3.12.4/Python-3.12.4.tgz && \
    tar -xf Python-3.12.4.tgz && \
    cd Python-3.12.4 && \
    ./configure --enable-optimizations && \
    make -j$(nproc) && \
    make altinstall && \
    cd .. && rm -rf Python-3.12.4 Python-3.12.4.tgz && \
    ln -sf /usr/local/bin/python3.12 /usr/local/bin/python3 && \
    ln -sf /usr/local/bin/pip3.12 /usr/local/bin/pip3

# Create a default virtual environment for pip installs
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install --no-cache-dir --timeout 120 --retries 3 psycopg2-binary requests browser-use

# Install Playwright's Chromium browser and its system dependencies
# --with-deps installs required system libraries (libglib2.0, libnss3, libatk, etc.)
# PLAYWRIGHT_BROWSERS_PATH ensures browsers are installed in a shared location accessible to all users
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN python3 -m playwright install --with-deps chromium && \
    chmod -R a+rx /opt/playwright-browsers

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

# Install Claude Code CLI using native installer
# The installer downloads to ~/.claude/downloads and installs to ~/.local/bin/claude
USER node
RUN curl -fsSL https://claude.ai/install.sh | bash
USER root

# Install OpenAI Codex CLI globally (always use latest version)
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

# Pre-clone repository at build time for faster container startup (optional)
# If GIT_REPO_URL is provided as a build arg, the repo is cloned during build
# so the entrypoint only needs to do a git pull instead of a full clone
ARG GIT_REPO_URL=""
ARG GIT_CLONE_DIR=""
COPY .build-temp/.ssh/ /tmp/.build-ssh/
RUN if [ -n "${GIT_REPO_URL}" ]; then \
        echo "Pre-cloning repository at build time..." && \
        mkdir -p /home/node/.ssh && \
        if ls /tmp/.build-ssh/id_* 1>/dev/null 2>&1; then \
            cp /tmp/.build-ssh/* /home/node/.ssh/ 2>/dev/null || true && \
            chmod 700 /home/node/.ssh && \
            chmod 600 /home/node/.ssh/* 2>/dev/null || true && \
            chown -R node:node /home/node/.ssh && \
            su -s /bin/bash node -c "ssh-keyscan github.com bitbucket.org gitlab.com >> /home/node/.ssh/known_hosts 2>/dev/null"; \
        fi && \
        if [ -n "${GIT_CLONE_DIR}" ]; then \
            TARGET_DIR="/workspace/${GIT_CLONE_DIR}"; \
        else \
            TARGET_DIR="/workspace/$(basename ${GIT_REPO_URL} .git)"; \
        fi && \
        chown node:node /workspace && \
        if su -s /bin/bash node -c "GIT_TERMINAL_PROMPT=0 git clone --depth 1 --config core.fsmonitor=false '${GIT_REPO_URL}' '${TARGET_DIR}'" 2>&1; then \
            su -s /bin/bash node -c "cd '${TARGET_DIR}' && git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'" && \
            touch /workspace/.build-cloned && \
            chown node:node /workspace/.build-cloned && \
            echo "Repository pre-cloned successfully"; \
        else \
            echo "Build-time clone failed (will clone at container startup instead)"; \
        fi && \
        rm -rf /home/node/.ssh; \
    fi && \
    rm -rf /tmp/.build-ssh

# Build-time npm install for faster startup (optional)
# If NPM_INSTALL_DIR is set, run npm install in that directory within the pre-cloned repo
# so that node_modules are baked into the image and don't need to be installed at runtime
ARG NPM_INSTALL_DIR=""
RUN if [ -n "${NPM_INSTALL_DIR}" ] && [ -n "${GIT_REPO_URL}" ]; then \
        if [ -n "${GIT_CLONE_DIR}" ]; then \
            INSTALL_PATH="/workspace/${GIT_CLONE_DIR}/${NPM_INSTALL_DIR}"; \
        else \
            INSTALL_PATH="/workspace/$(basename ${GIT_REPO_URL} .git)/${NPM_INSTALL_DIR}"; \
        fi && \
        if [ -d "${INSTALL_PATH}" ] && [ -f "${INSTALL_PATH}/package.json" ]; then \
            echo "Installing npm dependencies in ${INSTALL_PATH}..." && \
            su -s /bin/bash node -c "cd '${INSTALL_PATH}' && npm install" && \
            echo "npm dependencies installed successfully in ${NPM_INSTALL_DIR}"; \
        else \
            echo "Warning: ${INSTALL_PATH} does not exist or has no package.json (skipping npm install)"; \
        fi; \
    fi

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Environment variables for LLM CLI configuration
ENV CLAUDE_SKIP_PERMISSIONS="" \
    LLM_TYPE="claude" \
    HOME=/home/node \
    PATH="/home/node/.local/bin:/opt/venv/bin:/home/node/go/bin:/usr/local/go/bin:${PATH}"

# Switch to non-root user (use existing 'node' user)
USER node

# Set entrypoint
ENTRYPOINT ["/entrypoint.sh"]

# Default command (can be "claude" or "codex")
CMD ["llm"]
