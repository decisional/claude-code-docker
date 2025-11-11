# Publishing Claude Code to Homebrew

This guide walks you through making the Claude Code CLI tools publicly available via Homebrew.

## Overview

There are two main approaches to distribute via Homebrew:

1. **Homebrew Tap** (Recommended) - Create your own tap repository
2. **Homebrew Core** (Advanced) - Submit to official Homebrew repository

This guide covers the **Tap approach**, which is easier and more flexible.

## Prerequisites

- [ ] PR #12 merged to main
- [ ] All tests passing
- [ ] Documentation reviewed
- [ ] GitHub repository is public

## Step-by-Step Publishing Process

### Phase 1: Prepare Main Repository

#### 1. Merge the PR

```bash
# Once PR #12 is approved, merge it
# Then pull the latest main branch
git checkout main
git pull origin main
```

#### 2. Create a Release

```bash
# Tag the release
git tag -a v1.0.0 -m "Release v1.0.0: Homebrew package with per-project config"
git push origin v1.0.0
```

#### 3. Create GitHub Release

Go to: https://github.com/decisional/claude-code-docker/releases/new

- **Tag**: v1.0.0 (select the tag you just created)
- **Title**: v1.0.0 - Homebrew Package Release
- **Description**:
  ```markdown
  ## 🎉 First Official Release

  Claude Code is now available as a Homebrew package!

  ### Installation

  ```bash
  brew tap decisional/claude-code
  brew install claude-code
  cc-setup
  ```

  ### What's New

  - ✨ Per-project configuration with auto-detection
  - 🍺 Homebrew installation support
  - 🎯 Interactive setup prompts
  - 📦 System-wide command availability
  - 🔧 New commands: cc-init, cc-config, cc-setup, cc-build

  ### Getting Started

  ```bash
  # 1. Install via Homebrew
  brew tap decisional/claude-code
  brew install claude-code

  # 2. Run setup
  cc-setup

  # 3. Initialize your project
  cd /path/to/your/project
  cc-init

  # 4. Start Claude Code
  cc-start
  ```

  ### Documentation

  See [README.md](https://github.com/decisional/claude-code-docker/blob/main/README.md) for full documentation.

  ### System Requirements

  - macOS
  - Docker Desktop
  - Claude Code CLI

  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  ```

- **Publish release** ✅

### Phase 2: Create Homebrew Tap

#### 4. Create Tap Repository Structure

Run the helper script:

```bash
cd /path/to/llm-docker
./create-tap.sh
```

This creates `../homebrew-claude-code` with:
- `Formula/claude-code.rb` - The Homebrew formula
- `README.md` - Tap documentation

#### 5. Create GitHub Repository

1. Go to: https://github.com/organizations/decisional/repositories/new
2. **Repository name**: `homebrew-claude-code` (exact name is important!)
3. **Description**: "Homebrew tap for Claude Code CLI tools"
4. **Visibility**: Public ✅
5. **Initialize**: Don't add README, .gitignore, or license (we already have them)
6. **Create repository**

#### 6. Push Tap to GitHub

```bash
cd ../homebrew-claude-code
git remote add origin https://github.com/decisional/homebrew-claude-code.git
git push -u origin main
```

### Phase 3: Update Formula with Release Info

#### 7. Calculate SHA256 Hash

```bash
cd ../llm-docker
./update-formula.sh
```

Follow the prompts:
- Enter version: `v1.0.0`
- Script will automatically:
  - Download the release tarball
  - Calculate SHA256
  - Update both formula files
  - Show you the next steps

Or manually:

```bash
curl -L https://github.com/decisional/claude-code-docker/archive/refs/tags/v1.0.0.tar.gz | shasum -a 256
```

#### 8. Commit Updated Formula to Tap

```bash
cd ../homebrew-claude-code
git add Formula/claude-code.rb
git commit -m "Update formula to v1.0.0 with release SHA256"
git push
```

### Phase 4: Test Installation

#### 9. Test the Tap

```bash
# Remove any local installations first
brew uninstall claude-code 2>/dev/null || true

# Add the tap
brew tap decisional/claude-code

# Install
brew install claude-code

# Verify installation
which cc-start
cc-list

# Test setup (requires Docker and Claude CLI)
cc-setup
```

#### 10. Test Full Workflow

```bash
# Create a test directory
mkdir -p ~/test-claude-code
cd ~/test-claude-code

# Initialize a git repo
git init
git remote add origin https://github.com/decisional/claude-code-docker.git

# Test cc-init (should auto-detect repo)
cc-init

# Check config
cc-config

# Start (if Docker + credentials are set up)
cc-start

# List instances
cc-list
```

### Phase 5: Announce & Document

#### 11. Update Main Repository README

Add installation badge at the top of README.md:

```markdown
[![Homebrew](https://img.shields.io/badge/homebrew-available-orange)](https://github.com/decisional/homebrew-claude-code)
```

#### 12. Create Documentation

Add to main repository wiki or docs:
- Installation guide
- Configuration guide
- Migration guide from old method
- Troubleshooting

#### 13. Announce

Share on:
- GitHub Discussions
- Team Slack
- Internal documentation
- Twitter/social media (if appropriate)

## Users Can Now Install With:

```bash
# One-time setup
brew tap decisional/claude-code
brew install claude-code
cc-setup

# Per-project usage
cd /path/to/project
cc-init
cc-start
```

## Updating the Formula (Future Releases)

When you release a new version:

```bash
# 1. Tag and release in main repo
git tag v1.1.0
git push origin v1.1.0
# Create GitHub release

# 2. Update formula
cd /path/to/llm-docker
./update-formula.sh
# Enter version: v1.1.0

# 3. Push updated tap
cd ../homebrew-claude-code
git add Formula/claude-code.rb
git commit -m "Update formula to v1.1.0"
git push

# 4. Users update with:
brew upgrade claude-code
```

## Alternative: Submit to Homebrew Core (Advanced)

If you want to submit to the official Homebrew repository (not required):

### Requirements
- Significant user base
- Stable project
- Active maintenance
- Pass all Homebrew standards

### Process
1. Fork homebrew/homebrew-core
2. Add your formula to `Formula/`
3. Follow [Homebrew's formula guidelines](https://docs.brew.sh/Formula-Cookbook)
4. Submit PR to homebrew/homebrew-core
5. Address reviewer feedback
6. Wait for approval and merge

**Note**: This is much more rigorous and takes longer. Start with a tap first!

## Troubleshooting

### Formula SHA256 Mismatch

If users get SHA256 errors:
```bash
# Recalculate the hash
curl -L https://github.com/decisional/claude-code-docker/archive/refs/tags/v1.0.0.tar.gz | shasum -a 256

# Update formula with correct hash
# Commit and push
```

### Formula Not Found

Make sure:
- Tap repository name is exactly `homebrew-claude-code`
- Repository is public
- Formula file is at `Formula/claude-code.rb` (capital F!)
- User ran `brew update` after adding tap

### Installation Fails

Check:
- All file paths in formula are correct
- Dependencies are declared
- bin files are executable
- Test section works

## File Checklist

After following this guide, you should have:

```
decisional/claude-code-docker/          (main repository)
├── bin/                                (CLI commands)
├── lib/                                (Support files)
├── formula/                            (Formula definition)
├── README.md                           (Main documentation)
├── PUBLISHING.md                       (This file)
├── create-tap.sh                       (Helper script)
└── update-formula.sh                   (Helper script)

decisional/homebrew-claude-code/        (tap repository)
├── Formula/
│   └── claude-code.rb                  (Homebrew formula)
└── README.md                           (Tap documentation)
```

## Support

If you encounter issues during publishing:
1. Check [Homebrew documentation](https://docs.brew.sh/)
2. Review existing taps for examples
3. Test locally before pushing to tap
4. Ask in Homebrew discussions

## Success Metrics

After publishing, track:
- ⭐ GitHub stars on both repositories
- 📥 Number of installations (`brew analytics` if enabled)
- 🐛 Issues reported
- 💬 Community feedback
- 🔄 Update adoption rate

## License

This software is distributed under the MIT license. Make sure your formula includes:
```ruby
license "MIT"
```

---

**Remember**: The tap approach gives you full control and faster iteration. You can always submit to homebrew-core later once the project is more mature!
