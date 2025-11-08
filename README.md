# Claude Code Docker Environment

A Docker container with Claude Code CLI and Git pre-installed.

## Prerequisites

- Docker and Docker Compose installed
- Claude Code credentials (login with `claude login` on your host machine first)

## Setup

1. **Login to Claude on your host machine** (if you haven't already):
   ```bash
   claude login
   ```

2. **Run the setup script**:
   ```bash
   ./setup.sh
   ```

   This script will:
   - Copy your Claude credentials from `~/.claude/` to `./claude-data/`
   - Copy your Git config from `~/.gitconfig` to `./git-data/.gitconfig`
   - Copy your SSH keys from `~/.ssh/` to `./git-data/.ssh/`
   - Create the workspace directory
   - Create `.env` file and optionally configure a git repository to auto-clone
   - Local copies allow the container to save memories, settings, and git credentials

3. **Optional: Configure automatic git repository cloning**:

   Edit the `.env` file to specify a repository to automatically clone:
   ```bash
   # .env
   GIT_REPO_URL=git@github.com:username/repo.git
   GIT_BRANCH=main  # Optional: specify branch
   GIT_CLONE_DIR=my-project  # Optional: specify directory name
   ```

   Or let the setup script prompt you for these values interactively.

## Usage

### Authentication

Claude Code requires authentication to work. There are two approaches:

**Option 1: Authenticate once in a persistent container (Recommended)**

Use a persistent container instead of `--rm` to keep the session alive:

```bash
# Start a persistent container
docker-compose up -d

# Exec into it and run Claude (login once)
docker exec -it claude-code-env claude

# Authenticate when prompted
# Now you can keep using this same container

# Attach to it anytime:
docker attach claude-code-env

# Or run new Claude sessions in the same container:
docker exec -it claude-code-env claude
```

**Option 2: Fresh container each time (will ask for login)**

If you use `--rm`, each container is destroyed after exit:

```bash
# This will ask for authentication each time
docker-compose run --rm claude-code
# You'll need to login on each run
```

**Why does this happen?**

The credentials file (`./claude-data/.credentials.json`) containing your OAuth tokens **IS** properly saved and mounted into containers. However, Claude Code may perform additional runtime session validation beyond just checking the credentials file, which can trigger re-authentication in some scenarios.

**What's being saved:**
- OAuth Access Token (for API calls)
- OAuth Refresh Token (to renew access)
- Token expiration timestamp
- Your subscription type and scopes

All of this persists in `./claude-data/.credentials.json` on your host machine.

**Why can't we copy credentials from your Mac?**

On macOS, Claude Code stores credentials in the **system Keychain** (encrypted storage), not in a file. Docker containers cannot access your Mac's Keychain due to isolation. This is why you need to authenticate once inside the container, which then creates its own `.credentials.json` file that persists in `./claude-data/`.

### Quick Start (Persistent Container)

```bash
# Start the container in background
docker-compose up -d

# Run Claude Code (authenticate once on first run)
docker exec -it claude-code-env claude

# Stop the container when done
docker-compose down
```

### Alternative: One-off Container

```bash
# Run and remove after exit (will ask for login each time)
docker-compose run --rm claude-code
```

### Using Docker directly

**Build the image**:
```bash
docker build -t claude-code .
```

**Run interactively**:
```bash
docker run -it --rm \
  -v $(pwd)/workspace:/workspace \
  -v $(pwd)/claude-data:/root/.claude \
  -v $(pwd)/git-data/.gitconfig:/root/.gitconfig \
  -v $(pwd)/git-data/.ssh:/root/.ssh \
  claude-code
```

**Run with bash access**:
```bash
docker run -it --rm \
  -v $(pwd)/workspace:/workspace \
  -v $(pwd)/claude-data:/root/.claude \
  -v $(pwd)/git-data/.gitconfig:/root/.gitconfig \
  -v $(pwd)/git-data/.ssh:/root/.ssh \
  claude-code /bin/bash
```

## Features

- Node.js 20
- Claude Code CLI
- Git
- Automatic git repository cloning (optional, configured via .env)
- Writable Claude credentials directory (memories and settings persist)
- Writable Git configuration and SSH keys (git operations persist, can do git clone/push)
- Persistent workspace directory

## Customization

### Configure Git inside container

Git config is stored in `./git-data/.gitconfig` and persists between container runs. You can edit it directly or from inside the container:

```bash
docker exec -it claude-code-env bash
git config --global user.name "Your Name"
git config --global user.email "your.email@example.com"
```

Changes will be saved to `./git-data/.gitconfig` and persist across container restarts.

### Automatic Git Repository Cloning

The container automatically clones a git repository on startup if `GIT_REPO_URL` is set in `.env`:

```bash
# .env
GIT_REPO_URL=git@github.com:username/repo.git
GIT_BRANCH=main  # Optional: defaults to repo's default branch
GIT_CLONE_DIR=my-project  # Optional: defaults to repo name
```

**How it works:**
- On container startup, if `GIT_REPO_URL` is set, the entrypoint script clones the repo
- The repo is cloned into `/workspace/<directory-name>`
- If the directory already exists, cloning is skipped (preserves your local changes)
- Your working directory is automatically set to the cloned repo

**Example:**
```bash
# Set in .env
GIT_REPO_URL=git@github.com:myuser/myproject.git

# Run container
docker-compose run --rm claude-code

# Container automatically:
# 1. Clones myproject to /workspace/myproject
# 2. Changes to /workspace/myproject directory
# 3. Starts Claude Code in that directory
```

### Install additional tools

Modify the Dockerfile to add more dependencies:

```dockerfile
RUN apt-get update && apt-get install -y \
    git \
    curl \
    ca-certificates \
    vim \
    python3 \
    && rm -rf /var/lib/apt/lists/*
```

## Notes

- The `workspace` directory is where your projects should live
  - If `GIT_REPO_URL` is set, repositories are auto-cloned here on startup
  - All changes persist on your host machine
- The `claude-data` directory contains a writable copy of your Claude credentials
  - Memories and settings saved in the container will persist here
  - This is a local copy - your original `~/.claude` remains unchanged
  - Re-run `./setup.sh` if you need to refresh credentials from `~/.claude`
- The `git-data` directory contains writable Git config and SSH keys
  - Git operations (clone, push, pull) work seamlessly
  - SSH keys are copied with proper permissions (600/700)
  - Git credentials and config persist across container restarts
  - Your original `~/.gitconfig` and `~/.ssh` remain unchanged
  - Re-run `./setup.sh` if you need to refresh from your host system
- Configure automatic git cloning in `.env` file
  - Leave `GIT_REPO_URL` empty to skip auto-cloning
  - Repository is only cloned once (won't overwrite existing directories)
- You must run `claude login` on your host machine before running setup
- The container runs as root by default (consider adding a non-root user for production use)

## Troubleshooting

### Claude asks for login every time

This happens if the credentials aren't being persisted properly. To fix:

1. **Check your setup**:
   ```bash
   ./check-setup.sh
   ```

2. **Verify claude-data exists and has credentials**:
   ```bash
   ls -la ./claude-data/.credentials.json
   ```

3. **If the file exists but login is still required**:
   - Login once inside the container - the authentication will persist in `./claude-data`
   - On subsequent runs, you won't need to login again

4. **If credentials are missing**:
   ```bash
   # Re-run setup to copy credentials
   ./setup.sh
   ```

### Git clone fails with permission denied

Check that your SSH keys are properly copied:

```bash
ls -la ./git-data/.ssh/
# Should show your keys with proper permissions (600)
```

If keys are missing, re-run `./setup.sh`

### Container can't find git repository

Make sure `.env` file has the correct repository URL:

```bash
cat .env | grep GIT_REPO_URL
```
