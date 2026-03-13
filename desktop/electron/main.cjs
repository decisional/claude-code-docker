const { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, nativeTheme, powerMonitor, shell } = require("electron");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { fileURLToPath } = require("url");
const { execFile, spawn } = require("child_process");
const pty = require("node-pty");

const liveSessions = new Map();
const notificationCooldowns = new Map();
// Cache PR lookups per session: sessionId -> { branch, prNumber, prUrl }
const prCache = new Map();
let mainWindow = null;
let storePath = "";
let appState = {
  settings: {
    repoPath: "",
  },
  sessions: [],
};
let refreshInterval = null;
let systemSleeping = false;
let sessionsAttachedBeforeSleep = [];

const DEFAULT_WINDOW = {
  width: 1480,
  height: 920,
  minWidth: 980,
  minHeight: 640,
};

const COMMON_BIN_PATHS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  path.join(os.homedir(), ".docker", "bin"),
];

function createDefaultState() {
  return {
    settings: {
      repoPath: path.resolve(__dirname, "..", ".."),
    },
    sessions: [],
  };
}

async function ensureStateLoaded() {
  if (storePath) {
    return;
  }

  storePath = path.join(app.getPath("userData"), "desktop-state.json");

  try {
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw);
    appState = {
      ...createDefaultState(),
      ...parsed,
      settings: {
        ...createDefaultState().settings,
        ...(parsed.settings || {}),
      },
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  } catch {
    appState = createDefaultState();
    await persistState();
  }
}

async function persistState() {
  if (!storePath) {
    return;
  }

  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(appState, null, 2));
}

function currentRepoPath() {
  return appState.settings.repoPath || path.resolve(__dirname, "..", "..");
}

function buildSessionId(runtime, name) {
  return `${runtime}:${name}`;
}

function buildProjectName(runtime, name) {
  return `${runtime === "claude" ? "claude" : "codex"}-${name}`;
}

function buildContainerName(runtime, name) {
  return `${buildProjectName(runtime, name)}-claude-code-1`;
}

function dedupeSessions(sessions) {
  const seen = new Set();
  return sessions.filter(session => {
    if (seen.has(session.id)) {
      return false;
    }
    seen.add(session.id);
    return true;
  });
}

function sortedSessions(sessions) {
  return [...sessions].sort((a, b) => {
    return (b.createdAt || "").localeCompare(a.createdAt || "");
  });
}

function parseFileUrls(rawValue) {
  const text = `${rawValue || ""}`;
  return text
    .split(/[\r\n\0]+/)
    .map(entry => entry.trim())
    .filter(entry => entry.startsWith("file://"))
    .map(entry => {
      try {
        return fileURLToPath(entry);
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

function parseFinderFileList(rawValue) {
  const text = `${rawValue || ""}`;
  return [...text.matchAll(/<string>(.*?)<\/string>/g)].map(([, entry]) => entry).filter(Boolean);
}

function upsertSession(partial) {
  const existingIndex = appState.sessions.findIndex(session => session.id === partial.id);
  if (existingIndex >= 0) {
    appState.sessions[existingIndex] = {
      ...appState.sessions[existingIndex],
      ...partial,
    };
  } else {
    appState.sessions.push(partial);
  }
  appState.sessions = dedupeSessions(sortedSessions(appState.sessions));
}

function removeSessionById(sessionId) {
  appState.sessions = appState.sessions.filter(session => session.id !== sessionId);
}

function getSessionById(sessionId) {
  return appState.sessions.find(session => session.id === sessionId);
}

function emit(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send(channel, payload);
}

function buildRuntimeEnv(overrides = {}) {
  const nextEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => value !== undefined && value !== null)
    ),
    ...Object.fromEntries(
      Object.entries(overrides).filter(([, value]) => value !== undefined && value !== null)
    ),
  };

  const existingPathEntries = String(nextEnv.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  const dedupedPathEntries = [...new Set([...COMMON_BIN_PATHS, ...existingPathEntries])];

  nextEnv.PATH = dedupedPathEntries.join(path.delimiter);
  return nextEnv;
}

process.env.PATH = buildRuntimeEnv().PATH;

async function runCommand(filePath, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      filePath,
      args,
      {
        ...options,
        env: buildRuntimeEnv(options.env),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject({
            error,
            stdout,
            stderr,
          });
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

async function getDockerContainers() {
  try {
    const { stdout } = await runCommand("docker", [
      "ps",
      "-a",
      "--format",
      "{{.Names}}\t{{.State}}\t{{.Status}}",
    ]);

    return stdout
      .split("\n")
      .filter(Boolean)
      .map(line => {
        const [name, state, status] = line.split("\t");
        return { name, state, status };
      });
  } catch {
    return [];
  }
}

async function getContainerGitInfo(containerName) {
  try {
    const { stdout } = await runCommand("docker", [
      "exec",
      containerName,
      "bash",
      "-c",
      "cd /workspace/*/ 2>/dev/null && echo $(git branch --show-current) && git remote get-url origin",
    ]);
    const lines = stdout.trim().split("\n");
    const branch = (lines[0] || "").trim();
    const remoteUrl = (lines[1] || "").trim();
    // Extract org/repo from git@github.com:org/repo.git or https://github.com/org/repo.git
    const match = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+)/);
    const repoSlug = match ? match[1] : "";
    return { branch, repoSlug };
  } catch {
    return { branch: "", repoSlug: "" };
  }
}

// Patterns to skip when extracting thread titles from tmux output.
// These are setup prompts, menu selections, and other non-task text.
const THREAD_TITLE_SKIP_RE = /^(hi|hello|hey|yes|no|quit|exit|\d+\.\s|find and fix a bug in @)/i;

async function getContainerThreadTitle(containerName) {
  try {
    // Capture the tmux scrollback from the container's llm-session pane.
    // Parse user prompts (lines starting with ❯ or ›) and return the first
    // substantive one (>10 chars, skipping greetings and setup prompts).
    const { stdout } = await runCommand("docker", [
      "exec",
      containerName,
      "bash",
      "-c",
      `tmux capture-pane -t llm-session -p -S -500 2>/dev/null`,
    ]);

    const lines = stdout.split("\n");
    for (const line of lines) {
      // Claude Code uses ❯, Codex uses ›
      const promptMatch = line.match(/^[❯›]\s+(.+)$/);
      if (!promptMatch) continue;

      let text = promptMatch[1].trim();
      if (text.length <= 10) continue;
      if (THREAD_TITLE_SKIP_RE.test(text)) continue;

      // Truncate at first sentence boundary or 120 chars
      for (const sep of [". ", "\n"]) {
        const idx = text.indexOf(sep);
        if (idx > 0 && idx < 120) {
          text = text.slice(0, idx);
          break;
        }
      }

      return text.slice(0, 120);
    }

    return "";
  } catch {
    return "";
  }
}

async function getContainerDiffStats(containerName) {
  try {
    const { stdout } = await runCommand("docker", [
      "exec",
      containerName,
      "bash",
      "-c",
      'cd /workspace/*/ 2>/dev/null && git diff main --numstat 2>/dev/null || git diff HEAD --numstat 2>/dev/null || echo ""',
    ]);
    const lines = stdout.trim().split("\n").filter(Boolean);
    let totalAdditions = 0;
    let totalDeletions = 0;
    const files = [];
    for (const line of lines) {
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const additions = parts[0] === "-" ? 0 : parseInt(parts[0], 10) || 0;
      const deletions = parts[1] === "-" ? 0 : parseInt(parts[1], 10) || 0;
      const filePath = parts.slice(2).join("\t");
      totalAdditions += additions;
      totalDeletions += deletions;
      files.push({ path: filePath, additions, deletions });
    }
    return { totalAdditions, totalDeletions, files };
  } catch {
    return { totalAdditions: 0, totalDeletions: 0, files: [] };
  }
}

async function getContainerDiff(containerName, filePath) {
  try {
    const fileArg = filePath ? `-- ${filePath}` : "";
    const { stdout } = await runCommand("docker", [
      "exec",
      containerName,
      "bash",
      "-c",
      `cd /workspace/*/ 2>/dev/null && git diff main ${fileArg} 2>/dev/null || git diff HEAD ${fileArg} 2>/dev/null || echo ""`,
    ]);
    return stdout;
  } catch {
    return "";
  }
}

async function getPrForBranch(repoSlug, branch) {
  if (!repoSlug || !branch || branch === "main" || branch === "master") {
    return null;
  }
  try {
    const { stdout } = await runCommand("gh", [
      "pr",
      "list",
      "--repo",
      repoSlug,
      "--head",
      branch,
      "--json",
      "number,url",
      "--jq",
      ".[0]",
    ]);
    const trimmed = stdout.trim();
    if (!trimmed) {
      return null;
    }
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

async function refreshSessionsFromDocker() {
  const dockerSessions = await getDockerContainers();
  const enriched = [...appState.sessions];

  dockerSessions.forEach(container => {
    const claudePrefix = "claude-";
    const codexPrefix = "codex-";
    let runtime = null;
    let name = null;

    if (container.name.startsWith(claudePrefix) && container.name.endsWith("-claude-code-1")) {
      runtime = "claude";
      name = container.name.slice(claudePrefix.length, -"-claude-code-1".length);
    } else if (container.name.startsWith(codexPrefix) && container.name.endsWith("-claude-code-1")) {
      runtime = "codex";
      name = container.name.slice(codexPrefix.length, -"-claude-code-1".length);
    }

    if (!runtime || !name) {
      return;
    }

    const sessionId = buildSessionId(runtime, name);
    const existing = enriched.find(session => session.id === sessionId);
    const next = {
      id: sessionId,
      name,
      runtime,
      projectName: buildProjectName(runtime, name),
      containerName: container.name,
      status: liveSessions.has(sessionId) ? "attached" : container.state,
      dockerStatus: container.status,
      createdAt: existing?.createdAt || new Date().toISOString(),
      lastOpenedAt: existing?.lastOpenedAt || existing?.createdAt || new Date().toISOString(),
      branch: existing?.branch || "",
      port: existing?.port || "",
    };

    if (existing) {
      Object.assign(existing, next);
    } else {
      enriched.push(next);
    }
  });

  // Fetch current git branch and PR info for running containers (in parallel)
  const gitPromises = enriched.map(async session => {
    if (session.containerName && (session.status === "running" || session.status === "attached")) {
      const { branch, repoSlug } = await getContainerGitInfo(session.containerName);
      session.currentBranch = branch;
      session.repoSlug = repoSlug || "";

      // Only query GitHub for PR when the branch changes
      const cached = prCache.get(session.id);
      if (cached && cached.branch === branch) {
        session.prNumber = cached.prNumber;
        session.prUrl = cached.prUrl;
      } else {
        const pr = await getPrForBranch(repoSlug, branch);
        session.prNumber = pr ? pr.number : null;
        session.prUrl = pr ? pr.url : null;
        prCache.set(session.id, { branch, prNumber: session.prNumber, prUrl: session.prUrl });
      }

      // Also fetch diff stats for sidebar +/- counts
      const diffStats = await getContainerDiffStats(session.containerName);
      session.diffStats = diffStats;

      // Extract thread title from the active Claude Code conversation
      const threadTitle = await getContainerThreadTitle(session.containerName);
      if (threadTitle) {
        session.threadTitle = threadTitle;
      }
    }
  });
  await Promise.all(gitPromises);

  // Remove sessions whose Docker containers no longer exist (unless still starting)
  const dockerContainerNames = new Set(dockerSessions.map(c => c.name));
  const alive = enriched.filter(session => {
    if (session.status === "starting") return true;
    if (liveSessions.has(session.id)) return true;
    if (session.containerName && dockerContainerNames.has(session.containerName)) return true;
    return false;
  });

  appState.sessions = dedupeSessions(sortedSessions(alive));
  await persistState();
  emit("sessions:changed", appState.sessions);
  return appState.sessions;
}

function sessionScripts(runtime) {
  const repoPath = currentRepoPath();
  return {
    start: path.join(repoPath, runtime === "claude" ? "cc-start" : "codex-start"),
    stop: path.join(repoPath, runtime === "claude" ? "cc-stop" : "codex-stop"),
    remove: path.join(repoPath, runtime === "claude" ? "cc-rm" : "codex-rm"),
    reset: path.join(repoPath, runtime === "claude" ? "cc-reset" : "codex-reset"),
  };
}

function notifyIfHidden(title, body, options = {}) {
  if (!mainWindow || mainWindow.isFocused()) {
    return;
  }

  const cooldownKey = options.cooldownKey || "";
  const cooldownMs = options.cooldownMs || 0;
  if (cooldownKey && cooldownMs > 0) {
    const lastSentAt = notificationCooldowns.get(cooldownKey) || 0;
    if (Date.now() - lastSentAt < cooldownMs) {
      return;
    }
    notificationCooldowns.set(cooldownKey, Date.now());
  }

  try {
    const notification = new Notification({ title, body });
    notification.show();
  } catch {
    // Notifications can fail in some desktop environments. Ignore.
  }
}

async function startInteractiveSession(session, mode = "start", size = { cols: 120, rows: 32 }) {
  const existing = liveSessions.get(session.id);
  if (existing) {
    return session;
  }

  const scripts = sessionScripts(session.runtime);
  const scriptPath = mode === "reset" ? scripts.reset : scripts.start;
  const args = [scriptPath, session.name];

  if (mode === "start" && session.branch) {
    args.push("--branch", session.branch);
  }

  if (mode === "start" && session.runtime === "claude" && session.port) {
    args.push("--port", String(session.port));
  }

  const repoPath = currentRepoPath();
  const env = buildRuntimeEnv();

  let term;
  try {
    // Run the repo bash scripts directly rather than wrapping them in an extra
    // shell command string. This avoids macOS posix_spawn issues caused by
    // shell indirection and quoting.
    term = pty.spawn("/bin/bash", args, {
      cwd: repoPath,
      env,
      cols: size.cols || 120,
      rows: size.rows || 32,
      name: "xterm-256color",
    });
  } catch (error) {
    upsertSession({
      ...session,
      status: "error",
      dockerStatus: error?.message || "Failed to launch session.",
      lastOpenedAt: new Date().toISOString(),
    });
    await persistState();
    emit("sessions:changed", appState.sessions);
    throw error;
  }

  liveSessions.set(session.id, { term });

  upsertSession({
    ...session,
    status: "attached",
    dockerStatus: "Attaching...",
    lastOpenedAt: new Date().toISOString(),
  });
  await persistState();
  emit("sessions:changed", appState.sessions);

  term.onData(data => {
    emit("terminal:data", { sessionId: session.id, data });

    if (!mainWindow?.isFocused()) {
      notifyIfHidden(session.name, "Session received output.", {
        cooldownKey: `session-output:${session.id}`,
        cooldownMs: 15000,
      });
    }
  });

  term.onExit(async ({ exitCode, signal }) => {
    liveSessions.delete(session.id);

    // During system sleep, PTY dies with non-zero exit — treat as detached, not error,
    // so the session can be automatically reattached on wake.
    const isSleepDisconnect = systemSleeping || sessionsAttachedBeforeSleep.includes(session.id);
    const status = isSleepDisconnect || exitCode === 0 ? "detached" : "error";
    const dockerStatus = isSleepDisconnect
      ? "Disconnected (system sleep)"
      : signal
        ? `PTY exited (${signal})`
        : `PTY exited (${exitCode})`;

    upsertSession({
      ...getSessionById(session.id),
      status,
      dockerStatus,
      lastExitCode: exitCode,
    });
    await refreshSessionsFromDocker();
    emit("terminal:exit", { sessionId: session.id, exitCode, signal });

    if (!isSleepDisconnect) {
      notifyIfHidden(session.name, `Session exited${typeof exitCode === "number" ? ` with code ${exitCode}` : ""}.`);
    }
  });

  return getSessionById(session.id);
}

async function runDetachedScript(runtime, action, name) {
  const scripts = sessionScripts(runtime);
  const scriptPath = scripts[action];

  if (!scriptPath) {
    throw new Error(`Unknown action: ${action}`);
  }

  await new Promise((resolve, reject) => {
    const child = spawn(scriptPath, [name], {
      cwd: currentRepoPath(),
      env: buildRuntimeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";

    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("exit", code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `${action} exited with code ${code}`));
      }
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    ...DEFAULT_WINDOW,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#101010" : "#ffffff",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function validateRepoPath(repoPath) {
  const requiredScripts = ["cc-start", "codex-start", "cc-stop", "codex-stop"];
  return Promise.all(requiredScripts.map(script => fs.access(path.join(repoPath, script))))
    .then(() => true)
    .catch(() => false);
}

app.whenReady().then(async () => {
  await ensureStateLoaded();
  createWindow();
  await refreshSessionsFromDocker();

  refreshInterval = setInterval(() => {
    refreshSessionsFromDocker().catch(() => {});
  }, 5000);
});

powerMonitor.on("suspend", () => {
  systemSleeping = true;
  sessionsAttachedBeforeSleep = [];
  liveSessions.forEach((_live, sessionId) => {
    sessionsAttachedBeforeSleep.push(sessionId);
  });
});

powerMonitor.on("resume", () => {
  systemSleeping = false;
  const toReattach = [...sessionsAttachedBeforeSleep];
  sessionsAttachedBeforeSleep = [];

  // Give the system a moment to restore network/Docker after wake
  setTimeout(async () => {
    await refreshSessionsFromDocker().catch(() => {});

    for (const sessionId of toReattach) {
      // Only reattach if the PTY is gone but the container is still running
      if (liveSessions.has(sessionId)) {
        continue;
      }

      const session = getSessionById(sessionId);
      if (!session) {
        continue;
      }

      // Check if the Docker container is still running
      if (session.status !== "running" && session.status !== "detached") {
        continue;
      }

      try {
        await startInteractiveSession(session, "start");
        emit("sessions:changed", appState.sessions);
      } catch {
        // Container may have stopped during sleep; ignore and let user handle manually.
      }
    }
  }, 3000);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("before-quit", () => {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }

  liveSessions.forEach(({ term }) => {
    try {
      term.kill();
    } catch {
      // Ignore shutdown race.
    }
  });
});

ipcMain.handle("settings:get", async () => {
  await ensureStateLoaded();
  return appState.settings;
});

ipcMain.handle("settings:choose-repo-path", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Choose claude-code-docker repository",
  });

  if (result.canceled || !result.filePaths[0]) {
    return null;
  }

  const repoPath = result.filePaths[0];
  const valid = await validateRepoPath(repoPath);
  if (!valid) {
    throw new Error("Selected folder does not look like claude-code-docker.");
  }

  appState.settings.repoPath = repoPath;
  await persistState();
  await refreshSessionsFromDocker();
  return appState.settings;
});

ipcMain.handle("sessions:list", async () => {
  await ensureStateLoaded();
  return refreshSessionsFromDocker();
});

ipcMain.handle("sessions:create", async (_event, payload) => {
  await ensureStateLoaded();
  const name = String(payload.name || "").trim();
  const runtime = payload.runtime === "codex" ? "codex" : "claude";
  const branch = String(payload.branch || "").trim();
  const port = String(payload.port || "").trim();

  if (!name) {
    throw new Error("Session name is required.");
  }

  const session = {
    id: buildSessionId(runtime, name),
    name,
    runtime,
    branch,
    port,
    projectName: buildProjectName(runtime, name),
    containerName: buildContainerName(runtime, name),
    status: "starting",
    dockerStatus: "Starting...",
    createdAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
  };

  upsertSession(session);
  await persistState();
  await startInteractiveSession(session, "start", payload.size || undefined);
  return getSessionById(session.id);
});

ipcMain.handle("sessions:attach", async (_event, payload) => {
  const session = getSessionById(payload.sessionId);
  if (!session) {
    throw new Error("Session not found.");
  }
  await startInteractiveSession(session, "start", payload.size || undefined);
  await refreshSessionsFromDocker();
  return getSessionById(session.id);
});

ipcMain.handle("sessions:reset", async (_event, payload) => {
  const session = getSessionById(payload.sessionId);
  if (!session) {
    throw new Error("Session not found.");
  }

  const live = liveSessions.get(session.id);
  if (live) {
    try {
      live.term.kill();
    } catch {
      // Ignore.
    }
    liveSessions.delete(session.id);
  }

  await startInteractiveSession(session, "reset", payload.size || undefined);
  return getSessionById(session.id);
});

ipcMain.handle("sessions:input", async (_event, payload) => {
  const live = liveSessions.get(payload.sessionId);
  if (!live) {
    return false;
  }
  live.term.write(payload.data);
  return true;
});

ipcMain.handle("sessions:resize", async (_event, payload) => {
  const live = liveSessions.get(payload.sessionId);
  if (!live) {
    return false;
  }
  live.term.resize(Math.max(40, payload.cols || 120), Math.max(12, payload.rows || 32));
  return true;
});

ipcMain.handle("sessions:get-diff-files", async (_event, payload) => {
  const session = getSessionById(payload.sessionId);
  if (!session || !session.containerName) {
    return { totalAdditions: 0, totalDeletions: 0, files: [] };
  }
  return getContainerDiffStats(session.containerName);
});

ipcMain.handle("sessions:get-file-diff", async (_event, payload) => {
  const session = getSessionById(payload.sessionId);
  if (!session || !session.containerName) {
    return "";
  }
  return getContainerDiff(session.containerName, payload.filePath || "");
});

ipcMain.handle("clipboard:read-text", async () => clipboard.readText());

ipcMain.handle("clipboard:read-file-paths", async () => {
  const formats = clipboard.availableFormats();
  const paths = [];

  // macOS: files copied from Finder
  if (formats.includes("NSFilenamesPboardType")) {
    paths.push(...parseFinderFileList(clipboard.read("NSFilenamesPboardType")));
    paths.push(...parseFinderFileList(clipboard.readBuffer("NSFilenamesPboardType").toString("utf8")));
  }

  for (const format of ["public.file-url", "public.url", "text/uri-list"]) {
    if (!formats.includes(format)) {
      continue;
    }

    paths.push(...parseFileUrls(clipboard.read(format)));
    paths.push(...parseFileUrls(clipboard.readBuffer(format).toString("utf8")));
  }

  return [...new Set(paths)].filter(Boolean);
});

ipcMain.handle("shell:open-external", async (_event, url) => {
  if (typeof url === "string" && url.startsWith("https://")) {
    await shell.openExternal(url);
  }
});

ipcMain.handle("dialog:confirm", async (_event, options) => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: "question",
    buttons: options.buttons || ["Cancel", "OK"],
    defaultId: options.defaultId ?? 0,
    message: options.message || "Are you sure?",
  });
  return result.response === 1;
});

ipcMain.handle("docker:prune", async () => {
  const { stdout } = await runCommand("docker", ["system", "prune", "-f"]);
  return stdout.trim();
});

ipcMain.handle("sessions:stop", async (_event, payload) => {
  const session = getSessionById(payload.sessionId);
  if (!session) {
    throw new Error("Session not found.");
  }

  const live = liveSessions.get(session.id);
  if (live) {
    try {
      live.term.kill();
    } catch {
      // Ignore.
    }
    liveSessions.delete(session.id);
  }

  await runDetachedScript(session.runtime, "stop", session.name);
  await refreshSessionsFromDocker();
  return getSessionById(session.id);
});

ipcMain.handle("sessions:remove", async (_event, payload) => {
  const session = getSessionById(payload.sessionId);
  if (!session) {
    throw new Error("Session not found.");
  }

  const live = liveSessions.get(session.id);
  if (live) {
    try {
      live.term.kill();
    } catch {
      // Ignore.
    }
    liveSessions.delete(session.id);
  }

  await runDetachedScript(session.runtime, "remove", session.name);
  removeSessionById(session.id);
  await persistState();
  await refreshSessionsFromDocker();
  return true;
});
