# Desktop App

Plain Electron desktop surface for managing Claude Code and Codex Docker sessions from one window.

## What v1 does

- Creates new Claude or Codex sessions
- Opens existing sessions in an embedded terminal
- Shows all known sessions in a left sidebar
- Lets you stop, reset, and remove sessions
- Polls Docker for current container status

## Important v1 behavior

The terminal session is hosted by the desktop app process. If you fully quit the app while an attached Claude/Codex terminal is open, that attached interactive process will likely end too. The Docker container itself still remains.

That is acceptable for a first version. Durable reconnect across app restarts is the next step.

## Run

```bash
cd desktop
npm install
npm run dev
```

## Production-style local run

```bash
cd desktop
npm install
npm run build
npm run start
```
