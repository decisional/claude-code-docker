FROM node:20-slim

# Install system dependencies including Git
RUN apt-get update && apt-get install -y \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Create .claude directory for credentials
RUN mkdir -p /root/.claude

# Create a non-root user for Claude Code
RUN useradd -m -u 1000 -s /bin/bash claude && \
    mkdir -p /home/claude/.claude && \
    mkdir -p /workspace && \
    chown -R claude:claude /home/claude /workspace

# Copy credentials from build context
# This file is created by build.sh from macOS Keychain
# Run build.sh to extract credentials before building
COPY .build-temp/.credentials.json /home/claude/.claude/.credentials.json
RUN chmod 600 /home/claude/.claude/.credentials.json && \
    chown claude:claude /home/claude/.claude/.credentials.json

# Set up working directory
WORKDIR /workspace

# Configure Git as the claude user
USER claude
RUN git config --global init.defaultBranch main
USER root

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Environment variables for Claude Code flags
ENV CLAUDE_SKIP_PERMISSIONS="" \
    HOME=/home/claude

# Switch to non-root user
USER claude

# Set entrypoint
ENTRYPOINT ["/entrypoint.sh"]

# Default command to run Claude Code
CMD ["claude"]
