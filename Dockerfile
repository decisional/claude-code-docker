FROM node:20-slim

# Install system dependencies including Git, zsh, and GitHub CLI
RUN apt-get update && apt-get install -y \
    git \
    curl \
    ca-certificates \
    zsh \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI (detect architecture)
RUN ARCH=$(dpkg --print-architecture) && \
    wget https://github.com/cli/cli/releases/download/v2.40.0/gh_2.40.0_linux_${ARCH}.deb && \
    dpkg -i gh_2.40.0_linux_${ARCH}.deb && \
    rm gh_2.40.0_linux_${ARCH}.deb

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

# Configure Git and set zsh as default shell for node user
USER node
RUN git config --global init.defaultBranch main
USER root
RUN chsh -s /bin/zsh node

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
