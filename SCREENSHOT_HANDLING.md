# Screenshot Handling - How It Works

## Overview

The workflow orchestrator automatically handles screenshots from Linear tickets in **3 layers** to ensure agents can see and understand visual requirements.

## The 3-Layer Approach

```
┌─────────────────────────────────────────────────────────────┐
│  Linear Ticket (DEC-123)                                    │
│  - Title: "Add login screen"                                │
│  - Description: "Create new login UI"                       │
│  - Attachments:                                             │
│    • login-mockup.png                                       │
│    • user-flow.png                                          │
└─────────────────────────────────────────────────────────────┘
                         ↓
              ./workflow start DEC-123
                         ↓
┌─────────────────────────────────────────────────────────────┐
│  Orchestrator Downloads & Processes                         │
└─────────────────────────────────────────────────────────────┘
                         ↓
         ┌───────────────┴───────────────┐
         ↓                               ↓

📁 workflows/wf_abc123/

├── 📄 linear-ticket.md
│   ├── # DEC-123: Add login screen
│   ├── ## Description
│   ├── Create new login UI
│   ├── ## Attachments & Screenshots
│   ├── ### login-mockup.png
│   ├── ![login-mockup](./attachments/login-mockup.png)
│   └── _Image file: `./attachments/login-mockup.png`_
│
├── 📄 SCREENSHOTS.md  ⭐ KEY FILE
│   ├── # Screenshots & Attachments
│   ├── **IMPORTANT: Use Read tool to view each image**
│   ├──
│   ├── ## login-mockup.png
│   ├── **File:** `./attachments/login-mockup.png`
│   ├── **To view:** Use Read tool on this file
│   └── ![login-mockup](./attachments/login-mockup.png)
│
└── 📁 attachments/
    ├── 🖼️ login-mockup.png     ← Actual image file
    └── 🖼️ user-flow.png        ← Actual image file
```

## What Agents Do

### Planner Agent (Step 1)

```bash
# Planner container starts with this prompt:
"1. Check if /workspace/SCREENSHOTS.md exists
 2. Read it and use Read tool on each screenshot
 3. Read linear-ticket.md for full context
 4. Create implementation plan"
```

**Agent's actions:**
```
→ Read SCREENSHOTS.md
→ Found: ./attachments/login-mockup.png
→ Read ./attachments/login-mockup.png
   (Claude/Codex now SEES the image - it's multimodal)
→ Analyzes UI: "Blue button, centered form, 2 input fields"
→ Read linear-ticket.md for more context
→ Creates plan.md with visual details included
```

### Executor Agent (Step 2)

```bash
# Executor container starts with similar prompt:
"1. Check if /workspace/SCREENSHOTS.md exists
 2. Read it and use Read tool on each screenshot
 3. Read plan.md to see what to implement
 4. Match the visual requirements shown in screenshots"
```

**Agent's actions:**
```
→ Read SCREENSHOTS.md
→ Read ./attachments/login-mockup.png
   (Sees the exact UI to build)
→ Read plan.md
→ Implements login screen matching the mockup
→ Creates PR with screenshots reference
```

## Example: Real Workflow

```bash
$ ./workflow start DEC-123

✓ Workflow created: wf_abc123
  Fetching ticket from Linear...
  ✓ Downloaded 2 attachments
  ✓ Created SCREENSHOTS.md
  ✓ Embedded images in linear-ticket.md

Starting planner (Codex)...
  [Planner logs:]
  > Reading SCREENSHOTS.md...
  > Found 2 screenshots to review
  > Reading ./attachments/login-mockup.png...
  > Image shows: centered login form, blue primary button
  > Creating plan with UI specifications...
  ✓ Plan created

Starting executor (Claude)...
  [Executor logs:]
  > Reading SCREENSHOTS.md...
  > Viewing login-mockup.png...
  > Implementing login form to match mockup...
  > - Centered layout ✓
  > - Blue button (#4F46E5) ✓
  > - Two input fields ✓
  ✓ PR created: https://github.com/org/repo/pull/456
```

## Why 3 Layers?

1. **SCREENSHOTS.md** - Explicit checklist for agents
   - Clear instructions to use Read tool
   - One file to check for all images
   - Easy for agents to find

2. **linear-ticket.md** - Full context with embedded images
   - Shows images inline with description
   - Provides complete ticket information
   - Backup reference for visual requirements

3. **attachments/** - Actual image files
   - Downloaded from Linear
   - Available for Read tool
   - Viewable by multimodal LLMs (Claude/GPT-4V)

## Supported Image Types

✅ PNG (.png)
✅ JPEG (.jpg, .jpeg)
✅ GIF (.gif)
✅ WebP (.webp)
✅ SVG (.svg)

## Verification

Check if screenshots are working:

```bash
# View the manifest
$ cat workflows/wf_abc123/SCREENSHOTS.md

# Check files were downloaded
$ ls workflows/wf_abc123/attachments/

# See if agent read them
$ ./workflow logs wf_abc123 | grep -i "screenshot\|image\|Read.*png"
```

## Result

**Agents can now:**
- ✅ See exactly what UI to build
- ✅ Match colors, spacing, layouts
- ✅ Understand visual requirements
- ✅ Reference screenshots during implementation
- ✅ Create accurate implementations from mockups

The screenshot handling is **fully automatic** - you just need to attach images to your Linear ticket and the orchestrator handles the rest!
