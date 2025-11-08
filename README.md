# Claude Code Docker Environment

A Docker container with Claude Code CLI and Git pre-installed.

## Prerequisites

- Docker and Docker Compose installed
- Claude Code installed on macOS (run `claude login` to authenticate)
- Git configured on your host machine

## Setup

### Option 1: Build Image with Credentials Baked In (Recommended)

This approach extracts credentials from your macOS Keychain and bakes them directly into the Docker image:

```bash
# 1. Login to Claude on your Mac (one-time)
claude login

# 2. Build the Docker image with credentials
./build.sh

# 3. Run containers - no authentication needed!
docker-compose run --rm claude-code
```

**How it works:**
- `build.sh` extracts your OAuth credentials from macOS Keychain
- Credentials are copied into the Docker image during build
- Every container from this image is pre-authenticated
- Rebuild when credentials expire or you want to update

### Option 2: Volume-Based Setup (Alternative)

If you prefer to manage credentials as mounted volumes:

```bash
# 1. Run setup script
./setup.sh

# This will:
# - Copy Git config from ~/.gitconfig to ./git-data/
# - Copy SSH keys from ~/.ssh/ to ./git-data/
# - Create workspace directory
# - Create .env file for git repository configuration

# 2. Authenticate on first run
docker-compose up -d
docker exec -it claude-code-env claude
# Login when prompted - credentials saved to ./claude-data/
```

### Configure Automatic Git Repository Cloning (Optional)

Edit `.env` to auto-clone a repository on container startup:

```bash
# .env
GIT_REPO_URL=git@github.com:username/repo.git
GIT_BRANCH=main  # Optional: specify branch
GIT_CLONE_DIR=my-project  # Optional: specify directory name
```

### Configure Claude Code Runtime Flags (Optional)

Edit `.env` to run Claude with the `--dangerously-skip-permissions` flag:

```bash
# .env
# Enable --dangerously-skip-permissions flag
CLAUDE_SKIP_PERMISSIONS=true
```

**Warning:** Use this flag with extreme caution:
- `--dangerously-skip-permissions`: Bypasses all permission checks (includes both auto-approve and sandboxing bypass)
- Recommended only for sandboxes with no internet access
- Use only in trusted Docker container environments where you want full automation

## Usage

### If you used build.sh (Credentials Baked In)

Containers are pre-authenticated - just run them:

```bash
# One-off container (recommended for quick tasks)
docker-compose run --rm claude-code

# Or persistent container
docker-compose up -d
docker exec -it claude-code-env claude

# Stop when done
docker-compose down
```

**Benefits:**
- ✅ No authentication prompts
- ✅ Works with `--rm` (disposable containers)
- ✅ Credentials in the image itself
- ⚠️ Rebuild image when credentials expire

### If you used setup.sh (Volume-Based)

Use persistent containers to avoid re-authentication:

```bash
# Start a persistent container
docker-compose up -d

# Run Claude (authenticate on first run)
docker exec -it claude-code-env claude

# Future runs in same container - no login needed
docker exec -it claude-code-env claude

# Stop when done
docker-compose down
```

**Note:** If using `docker-compose run --rm`, you may be asked to authenticate each time since the container is destroyed after exit.

## Advanced Usage

### Using Docker directly (without docker-compose)

```bash
# Build image (uses build.sh approach)
./build.sh

# Run container
docker run -it --rm \
  -v $(pwd)/workspace:/workspace \
  -e GIT_REPO_URL=https://github.com/user/repo \
  claude-code-docker_claude-code

# Or with bash access
docker run -it --rm \
  -v $(pwd)/workspace:/workspace \
  claude-code-docker_claude-code /bin/bash
```

## Features

- Node.js 20
- Claude Code CLI
- Git
- Automatic git repository cloning (optional, configured via .env)
- Configurable Claude runtime flag (`--dangerously-skip-permissions`)
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

### Error: "not a directory" when mounting .gitconfig

If you see an error like:
```
error mounting ".../git-data/.gitconfig" to rootfs at "/root/.gitconfig":
not a directory: Are you trying to mount a directory onto a file (or vice-versa)?
```

This happens when Docker created `.gitconfig` as a directory instead of a file. To fix:

```bash
# Quick fix - run the fix script
./fix-gitconfig.sh
```

Or manually:
```bash
# Remove the incorrect directory
rm -rf git-data/.gitconfig

# Run build.sh again (it now handles git config setup)
./build.sh
```

**Why this happens:** Earlier versions of `build.sh` didn't create the `git-data/.gitconfig` file. When `docker-compose` tried to mount the non-existent file, Docker created it as a directory instead, causing the error.

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
