FROM node:20-slim

# Install system dependencies including Git
RUN apt-get update && apt-get install -y \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Use existing 'node' user (UID 1000) for Claude Code
# Create directories and set permissions
RUN mkdir -p /home/node/.claude /workspace && \
    chown -R node:node /home/node/.claude /workspace

# Copy credentials from build context
# This file is created by build.sh from macOS Keychain
# Run build.sh to extract credentials before building
COPY .build-temp/.credentials.json /home/node/.claude/.credentials.json
RUN chmod 600 /home/node/.claude/.credentials.json && \
    chown node:node /home/node/.claude/.credentials.json

# Set up working directory
WORKDIR /workspace

# Configure Git as the node user
USER node
RUN git config --global init.defaultBranch main
USER root

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Environment variables for Claude Code flags
ENV CLAUDE_SKIP_PERMISSIONS="" \
    HOME=/home/node

# Switch to non-root user (use existing 'node' user)
USER node

# Set entrypoint
ENTRYPOINT ["/entrypoint.sh"]

# Default command to run Claude Code
CMD ["claude"]
