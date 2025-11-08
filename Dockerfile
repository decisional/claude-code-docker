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

# Copy credentials from build context
# This file is created by build.sh from macOS Keychain
# Run build.sh to extract credentials before building
COPY .build-temp/.credentials.json /root/.claude/.credentials.json
RUN chmod 600 /root/.claude/.credentials.json

# Set up working directory
WORKDIR /workspace

# Configure Git (users can override these)
RUN git config --global init.defaultBranch main

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Environment variables for Claude Code flags
ENV CLAUDE_SKIP_PERMISSIONS="" \
    CLAUDE_DANGEROUSLY=""

# Set entrypoint
ENTRYPOINT ["/entrypoint.sh"]

# Default command to run Claude Code
CMD ["claude"]
