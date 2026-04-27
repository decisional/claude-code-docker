const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, nativeTheme, powerMonitor, shell } = require("electron");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { fileURLToPath } = require("url");
const https = require("https");
const { execFile, spawn } = require("child_process");
const pty = require("node-pty");

const MAX_TERMINAL_HISTORY_BYTES = 8 * 1024 * 1024;
const liveSessions = new Map();
const notificationCooldowns = new Map();
const terminalHistory = new Map();
// Cache PR lookups per session: sessionId -> { branch, prNumber, prUrl, state, isDraft, mergedAt, checks, checksStatus, fetchedAt }
const prCache = new Map();
// Minimum delay between full PR+checks refreshes for a session whose branch
// hasn't changed. Session refresh loop fires every 5s; we don't need to hammer
// `gh` that often for status that typically changes over tens of seconds.
const PR_STATUS_TTL_MS = 30_000;
// Set of session IDs currently being removed — resize events are suppressed for
// all *other* sessions while a removal is in progress to avoid layout-shift
// triggered resizes that cause tmux reflow / scrollback loss.
const removingSessionIds = new Set();
let terminalTabCounter = 0;
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

function defaultRepoPath() {
  // In packaged app, read the repo path that was embedded at build time.
  // In dev, __dirname is desktop/electron, so ../../ is the repo root.
  if (app.isPackaged) {
    try {
      const buildInfo = JSON.parse(require("fs").readFileSync(path.join(__dirname, "build-info.json"), "utf8"));
      return buildInfo.repoPath || "";
    } catch {
      return "";
    }
  }
  return path.resolve(__dirname, "..", "..");
}

function createDefaultState() {
  return {
    settings: {
      repoPath: defaultRepoPath(),
      linearApiKey: "",
      linearProject: "",
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

    // Fix corrupted repoPath that points inside a .app bundle
    const rp = appState.settings.repoPath;
    if (rp && rp.includes(".app/")) {
      appState.settings.repoPath = defaultRepoPath();
      await persistState();
    }
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
  return appState.settings.repoPath || defaultRepoPath();
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

const SUPPORTED_REPOS = new Set(["autodex", "opendex"]);
const DEFAULT_REPO = "autodex";

function normalizeRepoKey(value) {
  const raw = String(value || "").trim().toLowerCase();
  return SUPPORTED_REPOS.has(raw) ? raw : DEFAULT_REPO;
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

function appendTerminalHistory(sessionId, data) {
  if (!sessionId || typeof data !== "string" || data.length === 0) {
    return 0;
  }

  let entry = terminalHistory.get(sessionId);
  if (!entry) {
    entry = { lastSeq: 0, totalBytes: 0, chunks: [] };
  }

  const bytes = Buffer.byteLength(data, "utf8");
  entry.lastSeq += 1;
  entry.totalBytes += bytes;
  entry.chunks.push({ seq: entry.lastSeq, bytes, data });

  while (entry.totalBytes > MAX_TERMINAL_HISTORY_BYTES && entry.chunks.length > 1) {
    const removed = entry.chunks.shift();
    entry.totalBytes -= removed ? removed.bytes : 0;
  }

  terminalHistory.set(sessionId, entry);
  return entry.lastSeq;
}

function readTerminalHistory(sessionId) {
  const entry = terminalHistory.get(sessionId);
  if (!entry) {
    return { seq: 0, data: "" };
  }

  return {
    seq: entry.lastSeq,
    data: entry.chunks.map(chunk => chunk.data).join(""),
  };
}

function clearTerminalHistory(sessionId) {
  if (!sessionId) {
    return;
  }
  terminalHistory.delete(sessionId);
}

function clearTerminalHistoryForSession(sessionId) {
  if (!sessionId) {
    return;
  }

  for (const historyKey of terminalHistory.keys()) {
    if (historyKey === sessionId || historyKey.startsWith(`${sessionId}:`)) {
      terminalHistory.delete(historyKey);
    }
  }
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
  clearTerminalHistoryForSession(sessionId);
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

function requestCloseActiveSession() {
  emit("app:close-active-session");
}

function installApplicationMenu() {
  const fileMenu = {
    label: "File",
    submenu: [
      {
        label: "Close Session",
        accelerator: "CmdOrCtrl+W",
        click: () => requestCloseActiveSession(),
      },
    ],
  };

  if (process.platform === "darwin") {
    fileMenu.submenu.push(
      { type: "separator" },
      { label: "Close Window", accelerator: "CmdOrCtrl+Shift+W", role: "close" }
    );
  } else {
    fileMenu.submenu.push({ type: "separator" }, { role: "quit" });
  }

  const windowMenu = process.platform === "darwin"
    ? {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
      ],
    }
    : { role: "windowMenu" };

  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    fileMenu,
    { role: "editMenu" },
    { role: "viewMenu" },
    windowMenu,
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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

      return text.slice(0, 60);
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

function normalizeCheck(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.__typename === "StatusContext") {
    const state = (raw.state || "").toUpperCase();
    let status;
    if (state === "SUCCESS") status = "success";
    else if (state === "FAILURE" || state === "ERROR") status = "failure";
    else if (state === "PENDING" || state === "EXPECTED") status = "pending";
    else status = "neutral";
    return {
      name: raw.context || "status",
      workflow: "",
      status,
      conclusion: state.toLowerCase() || null,
      url: raw.targetUrl || "",
    };
  }
  // Default path covers CheckRun (GitHub Actions etc.)
  const runStatus = (raw.status || "").toUpperCase();
  const conclusion = (raw.conclusion || "").toUpperCase();
  let status;
  if (runStatus !== "COMPLETED") {
    status = "pending";
  } else if (conclusion === "SUCCESS") {
    status = "success";
  } else if (conclusion === "NEUTRAL" || conclusion === "SKIPPED") {
    status = "neutral";
  } else if (
    conclusion === "FAILURE" ||
    conclusion === "TIMED_OUT" ||
    conclusion === "CANCELLED" ||
    conclusion === "ACTION_REQUIRED" ||
    conclusion === "STALE" ||
    conclusion === "STARTUP_FAILURE"
  ) {
    status = "failure";
  } else {
    status = "neutral";
  }
  return {
    name: raw.name || "check",
    workflow: raw.workflowName || "",
    status,
    conclusion: conclusion ? conclusion.toLowerCase() : null,
    url: raw.detailsUrl || "",
  };
}

function rollupChecksStatus(checks) {
  if (!checks || checks.length === 0) return "none";
  let sawPending = false;
  let sawSuccess = false;
  for (const c of checks) {
    if (c.status === "failure") return "failure";
    if (c.status === "pending") sawPending = true;
    if (c.status === "success") sawSuccess = true;
  }
  if (sawPending) return "pending";
  if (sawSuccess) return "success";
  return "neutral";
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
      "--state",
      "all",
      "--json",
      "number,url,state,isDraft,mergedAt,statusCheckRollup",
      "--jq",
      ".[0]",
    ]);
    const trimmed = stdout.trim();
    if (!trimmed) {
      return null;
    }
    const raw = JSON.parse(trimmed);
    const checks = Array.isArray(raw.statusCheckRollup)
      ? raw.statusCheckRollup.map(normalizeCheck).filter(Boolean)
      : [];
    return {
      number: raw.number,
      url: raw.url,
      state: raw.state || "OPEN",
      isDraft: Boolean(raw.isDraft),
      mergedAt: raw.mergedAt || null,
      checks,
      checksStatus: rollupChecksStatus(checks),
    };
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
      repo: existing?.repo || DEFAULT_REPO,
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

      // Query GitHub for PR + checks when: branch changed, we haven't found a PR yet,
      // the PR is still open (checks can change), or cached status is older than TTL.
      const cached = prCache.get(session.id);
      const now = Date.now();
      const isOpenOrUnknown = !cached || cached.state === "OPEN";
      const stale = !cached || !cached.fetchedAt || now - cached.fetchedAt > PR_STATUS_TTL_MS;
      const branchChanged = !cached || cached.branch !== branch;
      const canReuse = cached && !branchChanged && cached.prNumber && (!isOpenOrUnknown || !stale);

      let pr;
      if (canReuse) {
        pr = cached;
      } else {
        const fetched = await getPrForBranch(repoSlug, branch);
        pr = fetched
          ? {
              branch,
              prNumber: fetched.number,
              prUrl: fetched.url,
              state: fetched.state,
              isDraft: fetched.isDraft,
              mergedAt: fetched.mergedAt,
              checks: fetched.checks,
              checksStatus: fetched.checksStatus,
              fetchedAt: now,
            }
          : { branch, prNumber: null, prUrl: null, state: null, isDraft: false, mergedAt: null, checks: [], checksStatus: "none", fetchedAt: now };
        prCache.set(session.id, pr);
      }

      session.prNumber = pr.prNumber || null;
      session.prUrl = pr.prUrl || null;
      session.prState = pr.state || null;
      session.prIsDraft = Boolean(pr.isDraft);
      session.prMergedAt = pr.mergedAt || null;
      session.prChecks = pr.checks || [];
      session.prChecksStatus = pr.checksStatus || "none";

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
    if (session.runtime === "terminal") return true;
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

async function startInteractiveSession(session, mode = "start", size) {
  const termSize = { cols: (size && size.cols) || 120, rows: (size && size.rows) || 32 };
  const existing = liveSessions.get(session.id);
  if (existing) {
    return session;
  }
  if (mode === "reset") {
    clearTerminalHistory(session.id);
  }

  const scripts = sessionScripts(session.runtime);
  const scriptPath = mode === "reset" ? scripts.reset : scripts.start;
  const args = [scriptPath, session.name, "--tmux"];

  if (mode === "start" && session.branch) {
    args.push("--branch", session.branch);
  }

  if (mode === "start" && session.runtime === "claude" && session.port) {
    args.push("--port", String(session.port));
  }

  if (mode === "start" && session.repo && session.repo !== DEFAULT_REPO) {
    args.push("--repo", session.repo);
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
      cols: termSize.cols,
      rows: termSize.rows,
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
    const seq = appendTerminalHistory(session.id, data);
    emit("terminal:data", { sessionId: session.id, seq, data });

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

function nextTerminalTabId() {
  terminalTabCounter += 1;
  return `tab-${terminalTabCounter}`;
}

function startTerminalTab(sessionId, tabId, size) {
  const termSize = { cols: (size && size.cols) || 120, rows: (size && size.rows) || 32 };
  const liveKey = `${sessionId}:${tabId}`;

  if (liveSessions.has(liveKey)) {
    return;
  }
  clearTerminalHistory(liveKey);

  const userShell = process.env.SHELL || "/bin/zsh";
  const term = pty.spawn(userShell, ["--login"], {
    cwd: os.homedir(),
    env: buildRuntimeEnv(),
    cols: termSize.cols,
    rows: termSize.rows,
    name: "xterm-256color",
  });

  liveSessions.set(liveKey, { term });

  term.onData(data => {
    const seq = appendTerminalHistory(liveKey, data);
    emit("terminal:data", { sessionId: liveKey, seq, data });
  });

  term.onExit(async () => {
    liveSessions.delete(liveKey);

    const session = getSessionById(sessionId);
    if (session && session.tabs) {
      session.tabs = session.tabs.filter(t => t !== tabId);
      if (session.tabs.length === 0) {
        removeSessionById(sessionId);
      } else {
        if (session.activeTabId === tabId) {
          session.activeTabId = session.tabs[session.tabs.length - 1];
        }
        upsertSession(session);
      }
      await persistState();
      emit("sessions:changed", appState.sessions);
    }

    emit("terminal:exit", { sessionId: liveKey, exitCode: 0 });
  });
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

// ── Linear API ──

function linearGraphQL(apiKey, query, variables = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const req = https.request(
      {
        hostname: "api.linear.app",
        path: "/graphql",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: apiKey,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      res => {
        let data = "";
        res.on("data", chunk => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.errors && parsed.errors.length > 0) {
              reject(new Error(parsed.errors[0].message));
            } else {
              resolve(parsed.data);
            }
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function fetchLinearProjects(apiKey) {
  const data = await linearGraphQL(apiKey, `{ projects(first: 50) { nodes { id name } } }`);
  return data.projects.nodes;
}

async function fetchLinearTodoTickets(apiKey, projectName) {
  const query = `
    query {
      viewer {
        id
        name
        email
      }
    }
  `;
  const viewerData = await linearGraphQL(apiKey, query);
  const viewerId = viewerData.viewer.id;

  const projectFilter = projectName ? `project: { name: { eq: "${projectName}" } }` : "";
  const ticketsQuery = `
    query($userId: ID!) {
      issues(
        filter: {
          assignee: { id: { eq: $userId } }
          state: { type: { eq: "unstarted" } }
          ${projectFilter}
        }
        orderBy: updatedAt
        first: 50
      ) {
        nodes {
          id
          identifier
          title
          description
          url
          priority
          state {
            name
            type
          }
          labels {
            nodes {
              name
            }
          }
          comments {
            nodes {
              body
              user {
                name
              }
              createdAt
            }
          }
        }
      }
    }
  `;
  const ticketsData = await linearGraphQL(apiKey, ticketsQuery, { userId: viewerId });
  return {
    viewer: viewerData.viewer,
    tickets: ticketsData.issues.nodes,
  };
}

async function moveLinearTicketToInProgress(apiKey, ticketId) {
  if (!apiKey || !ticketId) return;
  try {
    // First, find the "In Progress" state for this issue's team
    const issueData = await linearGraphQL(apiKey, `
      query($id: String!) {
        issue(id: $id) {
          team {
            states {
              nodes {
                id
                name
                type
              }
            }
          }
        }
      }
    `, { id: ticketId });

    const states = issueData.issue?.team?.states?.nodes || [];
    const inProgressState = states.find(s => s.type === "started") || states.find(s => s.name.toLowerCase().includes("progress"));
    if (!inProgressState) return;

    await linearGraphQL(apiKey, `
      mutation($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) {
          success
        }
      }
    `, { id: ticketId, stateId: inProgressState.id });
  } catch {
    // Non-fatal — don't block session creation if status update fails.
  }
}

async function injectLinearKeyIntoContainer(containerName, apiKey) {
  if (!apiKey || !containerName) return;
  try {
    await runCommand("docker", [
      "exec",
      containerName,
      "bash",
      "-c",
      `echo 'export LINEAR_API_KEY="${apiKey}"' >> /home/node/.bashrc && echo '${apiKey}' > /home/node/.linear-api-key && chmod 600 /home/node/.linear-api-key`,
    ]);
  } catch {
    // Non-fatal — container may not be ready yet.
  }
}

app.whenReady().then(async () => {
  await ensureStateLoaded();
  installApplicationMenu();
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

  // Send SIGHUP instead of SIGKILL so that tmux inside Docker containers
  // receives a clean detach signal rather than an abrupt kill.  This keeps the
  // tmux session alive for fast re-attach when the app restarts.
  liveSessions.forEach(({ term }, sessionId) => {
    try {
      // Terminal sessions (local shells) can be killed directly.
      if (sessionId.startsWith("terminal:")) {
        term.kill();
      } else {
        process.kill(term.pid, "SIGHUP");
      }
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

ipcMain.handle("sessions:get-terminal-history", async (_event, payload) => {
  const sessionId = String(payload?.sessionId || "");
  if (!sessionId) {
    return { seq: 0, data: "" };
  }
  return readTerminalHistory(sessionId);
});

ipcMain.handle("sessions:create", async (_event, payload) => {
  await ensureStateLoaded();
  const name = String(payload.name || "").trim();
  const runtime = payload.runtime === "terminal" ? "terminal" : payload.runtime === "codex" ? "codex" : "claude";
  const branch = String(payload.branch || "").trim();
  const port = String(payload.port || "").trim();
  const repo = normalizeRepoKey(payload.repo);

  if (!name) {
    throw new Error("Session name is required.");
  }

  if (runtime === "terminal") {
    const tabId = nextTerminalTabId();
    const session = {
      id: buildSessionId("terminal", name),
      name,
      runtime: "terminal",
      status: "attached",
      tabs: [tabId],
      activeTabId: tabId,
      createdAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString(),
    };

    upsertSession(session);
    await persistState();
    startTerminalTab(session.id, tabId, payload.size);
    emit("sessions:changed", appState.sessions);
    return getSessionById(session.id);
  }

  const session = {
    id: buildSessionId(runtime, name),
    name,
    runtime,
    branch,
    port,
    repo,
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
  if (session.runtime === "terminal") {
    return getSessionById(session.id);
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
  clearTerminalHistory(session.id);

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
  // While a session is being removed, layout shifts can trigger spurious resize
  // events on sibling terminals.  Suppress them to avoid tmux reflow / text loss.
  if (removingSessionIds.size > 0 && !removingSessionIds.has(payload.sessionId)) {
    return false;
  }
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
ipcMain.handle("clipboard:write-text", async (_event, text) => clipboard.writeText(text));

ipcMain.handle("clipboard:read-image", async (_event, sessionId) => {
  const image = clipboard.readImage();
  if (image.isEmpty()) {
    return null;
  }

  const session = getSessionById(sessionId);
  if (!session || !session.containerName) {
    return null;
  }

  const fileName = `clipboard-${Date.now()}.png`;
  const hostPath = path.join(os.tmpdir(), fileName);
  const containerPath = `/tmp/${fileName}`;

  await fs.writeFile(hostPath, image.toPNG());

  try {
    await runCommand("docker", ["cp", hostPath, `${session.containerName}:${containerPath}`]);
  } finally {
    fs.unlink(hostPath).catch(() => {});
  }

  return containerPath;
});

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

ipcMain.handle("linear:save-settings", async (_event, payload) => {
  await ensureStateLoaded();
  if (payload.linearApiKey !== undefined) {
    appState.settings.linearApiKey = payload.linearApiKey;
  }
  if (payload.linearProject !== undefined) {
    appState.settings.linearProject = payload.linearProject;
  }
  await persistState();
  return appState.settings;
});

ipcMain.handle("linear:get-projects", async () => {
  await ensureStateLoaded();
  const apiKey = appState.settings.linearApiKey;
  if (!apiKey) {
    throw new Error("Linear API key not configured.");
  }
  return fetchLinearProjects(apiKey);
});

ipcMain.handle("linear:get-tickets", async () => {
  await ensureStateLoaded();
  const apiKey = appState.settings.linearApiKey;
  if (!apiKey) {
    throw new Error("Linear API key not configured. Please add it in Settings.");
  }
  return fetchLinearTodoTickets(apiKey, appState.settings.linearProject || "");
});

ipcMain.handle("sessions:create-with-ticket", async (_event, payload) => {
  await ensureStateLoaded();
  const name = String(payload.name || "").trim();
  const runtime = payload.runtime === "codex" ? "codex" : "claude";
  const branch = String(payload.branch || "").trim();
  const port = String(payload.port || "").trim();
  const ticket = payload.ticket;

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
    linearTicketId: ticket?.identifier || "",
    linearTicketUrl: ticket?.url || "",
    linearTicketPrompt: "",
  };

  // Build the prompt for the user to copy-paste
  if (ticket) {
    session.linearTicketPrompt = `Pick up Linear ticket ${ticket.identifier}: ${ticket.title}\n\nThe Linear API key is at /home/node/.linear-api-key — use it to fetch the full ticket details, all comments, and attachments from the Linear GraphQL API (https://api.linear.app/graphql) before you start working. The ticket identifier is ${ticket.identifier}.`;
  }

  upsertSession(session);
  await persistState();

  await startInteractiveSession(session, "start", payload.size || { cols: 120, rows: 32 });

  // Inject Linear API key into the container and move ticket to In Progress
  const apiKey = appState.settings.linearApiKey;
  if (apiKey) {
    // Wait a moment for the container to be fully ready
    setTimeout(() => {
      injectLinearKeyIntoContainer(session.containerName, apiKey);
    }, 5000);

    // Move ticket to In Progress in Linear
    if (ticket && ticket.id) {
      moveLinearTicketToInProgress(apiKey, ticket.id).catch(() => {});
    }
  }

  return getSessionById(session.id);
});

ipcMain.handle("sessions:stop", async (_event, payload) => {
  const session = getSessionById(payload.sessionId);
  if (!session) {
    throw new Error("Session not found.");
  }

  if (session.runtime === "terminal") {
    for (const tabId of (session.tabs || [])) {
      const liveKey = `${session.id}:${tabId}`;
      const live = liveSessions.get(liveKey);
      if (live) {
        try { live.term.kill(); } catch {}
        liveSessions.delete(liveKey);
      }
    }
    removeSessionById(session.id);
    await persistState();
    emit("sessions:changed", appState.sessions);
    return true;
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

  if (session.runtime === "terminal") {
    for (const tabId of (session.tabs || [])) {
      const liveKey = `${session.id}:${tabId}`;
      const live = liveSessions.get(liveKey);
      if (live) {
        try { live.term.kill(); } catch {}
        liveSessions.delete(liveKey);
      }
    }
    removeSessionById(session.id);
    await persistState();
    emit("sessions:changed", appState.sessions);
    return true;
  }

  // Mark session as being removed so resize events on sibling sessions are
  // suppressed during the removal window (layout shifts can cause spurious
  // resizes that reflow tmux and lose scrollback in other terminals).
  removingSessionIds.add(session.id);

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
  // Emit the updated sessions list immediately without running docker exec on
  // every remaining container.  The periodic 5-second refresh will pick up
  // git/PR/diff info later.  This avoids triggering heavy re-renders (and
  // resize cascades) on sibling terminals right when the layout is shifting.
  emit("sessions:changed", appState.sessions);

  // Clear the removal guard after a short window so that any queued resize
  // events from the layout shift are dropped.
  setTimeout(() => {
    removingSessionIds.delete(session.id);
  }, 500);

  return true;
});

ipcMain.handle("sessions:create-tab", async (_event, payload) => {
  const session = getSessionById(payload.sessionId);
  if (!session || session.runtime !== "terminal") {
    throw new Error("Not a terminal session.");
  }

  const tabId = nextTerminalTabId();
  session.tabs = [...(session.tabs || []), tabId];
  session.activeTabId = tabId;
  upsertSession(session);
  await persistState();
  startTerminalTab(session.id, tabId, payload.size);
  emit("sessions:changed", appState.sessions);
  return { tabId, session: getSessionById(session.id) };
});

ipcMain.handle("sessions:close-tab", async (_event, payload) => {
  const session = getSessionById(payload.sessionId);
  if (!session || session.runtime !== "terminal") {
    throw new Error("Not a terminal session.");
  }

  const liveKey = `${session.id}:${payload.tabId}`;
  clearTerminalHistory(liveKey);
  const live = liveSessions.get(liveKey);
  if (live) {
    try { live.term.kill(); } catch {}
    liveSessions.delete(liveKey);
  }

  session.tabs = (session.tabs || []).filter(t => t !== payload.tabId);

  if (session.tabs.length === 0) {
    removeSessionById(session.id);
    await persistState();
    emit("sessions:changed", appState.sessions);
    return { removed: true };
  }

  if (session.activeTabId === payload.tabId) {
    session.activeTabId = session.tabs[session.tabs.length - 1];
  }

  upsertSession(session);
  await persistState();
  emit("sessions:changed", appState.sessions);
  return { removed: false, session: getSessionById(session.id) };
});
