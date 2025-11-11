# Release Checklist for Homebrew Distribution

Quick checklist for publishing Claude Code to Homebrew.

## Pre-Release

- [ ] PR #12 merged to main
- [ ] All tests passing
- [ ] Documentation complete
- [ ] README.md updated

## Phase 1: Create Release

```bash
# Pull latest main
git checkout main
git pull origin main

# Create tag
git tag -a v1.0.0 -m "Release v1.0.0: Homebrew package"
git push origin v1.0.0
```

- [ ] Tag created and pushed
- [ ] GitHub Release created at https://github.com/decisional/claude-code-docker/releases/new
- [ ] Release notes written

## Phase 2: Create Homebrew Tap

```bash
# Run helper script
./create-tap.sh
```

- [ ] Tap repository structure created in `../homebrew-claude-code`
- [ ] GitHub repository created: https://github.com/decisional/homebrew-claude-code
  - Repository name: `homebrew-claude-code` (exact!)
  - Visibility: Public
- [ ] Tap pushed to GitHub:
  ```bash
  cd ../homebrew-claude-code
  git remote add origin https://github.com/decisional/homebrew-claude-code.git
  git push -u origin main
  ```

## Phase 3: Update Formula

```bash
cd ../llm-docker
./update-formula.sh
# Enter: v1.0.0
```

- [ ] SHA256 calculated
- [ ] Formula files updated
- [ ] Changes committed to tap:
  ```bash
  cd ../homebrew-claude-code
  git add Formula/claude-code.rb
  git commit -m "Update formula to v1.0.0 with release SHA256"
  git push
  ```

## Phase 4: Test

```bash
# Uninstall any existing version
brew uninstall claude-code 2>/dev/null || true

# Install from tap
brew tap decisional/claude-code
brew install claude-code

# Verify
which cc-start
cc-list
```

- [ ] Installation successful
- [ ] All commands available
- [ ] `cc-setup` works
- [ ] `cc-init` works in test directory
- [ ] `cc-start` can create instance

## Phase 5: Announce

- [ ] Update main README with Homebrew badge
- [ ] Add installation instructions prominently
- [ ] Update internal documentation
- [ ] Announce to team

## Installation Command (for users)

```bash
brew tap decisional/claude-code
brew install claude-code
cc-setup
```

## Quick Commands Reference

| Command | Purpose |
|---------|---------|
| `./create-tap.sh` | Create tap repository structure |
| `./update-formula.sh` | Update formula with release SHA256 |
| `brew tap decisional/claude-code` | Add tap |
| `brew install claude-code` | Install package |
| `brew upgrade claude-code` | Update to latest |

## For Next Release

When releasing v1.1.0:

```bash
# 1. Tag release
git tag v1.1.0
git push origin v1.1.0

# 2. Create GitHub release

# 3. Update formula
./update-formula.sh
# Enter: v1.1.0

# 4. Push to tap
cd ../homebrew-claude-code
git add Formula/claude-code.rb
git commit -m "Update to v1.1.0"
git push
```

Users update with: `brew upgrade claude-code`

## Troubleshooting

**SHA256 mismatch?**
```bash
curl -L https://github.com/decisional/claude-code-docker/archive/refs/tags/v1.0.0.tar.gz | shasum -a 256
```
Update formula and push to tap.

**Formula not found?**
- Check tap repo name is exactly `homebrew-claude-code`
- Check repo is public
- Check formula is at `Formula/claude-code.rb`
- Run `brew update`

**Installation fails?**
- Check dependencies (Docker, docker-compose)
- Check file permissions (chmod +x bin/*)
- Check paths in formula

## Done! ✅

Once all boxes are checked, Claude Code is publicly available via Homebrew!
