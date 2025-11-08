# Shared Directory

This directory is mounted **read-only** at `/shared` in all Claude Code container instances.

## Purpose

Use this directory to share data across multiple container instances without rebuilding or restarting containers.

## Usage

```bash
# On your host machine, copy data here
cp -r /path/to/dataset ./shared/mydata

# Access from any running instance (read-only)
./cc-exec instance1
# Inside container: ls /shared/mydata
```

## Examples

**Share a dataset:**
```bash
cp -r ~/datasets/training-data ./shared/training-data
```

**Share configuration files:**
```bash
cp config.json ./shared/config.json
```

**Share models or prompts:**
```bash
cp -r ~/models/llama ./shared/models/llama
```

## Important Notes

- **Read-only mount:** Containers can only read from `/shared`, not write to it
- To update shared data, modify files in `./shared` on your host machine
- Changes made on host are immediately visible to all running instances
- Data persists on your host machine at `./shared`
- The directory itself is already in `.gitignore`

## Why Read-Only?

Read-only mounting prevents:
- Accidental data corruption from containers
- Multiple instances writing conflicting data
- Unintended modifications to shared resources

If you need to save output from a container, use `/workspace` instead.
