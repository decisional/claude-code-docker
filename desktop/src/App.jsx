import { useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

const EMPTY_SESSIONS = [];
// Registry so parent can focus a terminal by session ID
const terminalRegistry = new Map();
const SIDEBAR_STORAGE_KEY = "autodex-desktop:sidebar-collapsed";
const SIDEBAR_SHORTCUT_KEY = "b";

const STATUS_LABELS = {
  attached: "Attached",
  running: "Running",
  starting: "Starting",
  stopped: "Stopped",
  exited: "Stopped",
  detached: "Closed",
  error: "Error",
};

const SHELL_SAFE_PATH_RE = /^[A-Za-z0-9_./:@%+=,-]+$/;

function runtimeLabel(runtime) {
  return runtime === "codex" ? "Codex" : "Claude";
}

function statusLabel(status) {
  return STATUS_LABELS[status] || status || "Unknown";
}

function normalizeSessionName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function buildSuggestedSessionName(runtime, sessions, branch = "") {
  const existingNames = new Set(sessions.filter(session => session.runtime === runtime).map(session => session.name));
  const baseName = normalizeSessionName(branch) || "session-01";

  if (!existingNames.has(baseName)) {
    return baseName;
  }

  if (baseName !== "session-01") {
    let branchIndex = 2;

    while (existingNames.has(`${baseName}-${String(branchIndex).padStart(2, "0")}`)) {
      branchIndex += 1;
    }

    return `${baseName}-${String(branchIndex).padStart(2, "0")}`;
  }

  let sessionIndex = 2;

  while (existingNames.has(`session-${String(sessionIndex).padStart(2, "0")}`)) {
    sessionIndex += 1;
  }

  return `session-${String(sessionIndex).padStart(2, "0")}`;
}

function sessionMonogram(name) {
  const parts = String(name || "")
    .split(/[\s-]+/)
    .map(part => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
  }

  return String(name || "S")
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 2)
    .toUpperCase();
}

function sessionTitle(session) {
  const branchDisplay = session.currentBranch || session.branch || "";
  const facts = [runtimeLabel(session.runtime), branchDisplay ? `branch ${branchDisplay}` : "", session.prNumber ? `PR #${session.prNumber}` : "", session.port ? `port ${session.port}` : ""].filter(Boolean);
  return [session.name, facts.join(" | "), session.dockerStatus || ""].filter(Boolean).join("\n");
}

function escapePathForShell(filePath) {
  if (!filePath) {
    return "";
  }

  if (SHELL_SAFE_PATH_RE.test(filePath)) {
    return filePath;
  }

  return `'${filePath.replaceAll("'", "'\\''")}'`;
}

function formatPathsForTerminal(paths) {
  return paths.map(escapePathForShell).filter(Boolean).join(" ");
}

function clipboardPathsFromText(text) {
  const entries = text
    .split(/\r?\n/)
    .map(entry => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    return [];
  }

  const paths = entries.map(entry => {
    if (entry.startsWith("file://")) {
      try {
        return decodeURIComponent(new URL(entry).pathname);
      } catch {
        return "";
      }
    }

    if (entry.startsWith("/") || /^[A-Za-z]:[\\/]/.test(entry)) {
      return entry;
    }

    return "";
  });

  return paths.every(Boolean) ? paths : [];
}

function SessionTerminal({ sessionId, active }) {
  const containerRef = useRef(null);
  const terminalRef = useRef(null);
  const fitRef = useRef(null);
  const activeRef = useRef(active);
  const resizeTimerRef = useRef(null);
  const lastResizeRef = useRef({ cols: 0, rows: 0 });

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    if (!containerRef.current) {
      return undefined;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      theme: {
        background: "#0d1017",
        foreground: "#edf2f7",
        cursor: "#f7fafc",
        selectionBackground: "#243244",
      },
      scrollback: 10000,
      allowTransparency: false,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(containerRef.current);
    fit.fit();

    terminalRef.current = terminal;
    fitRef.current = fit;
    terminalRegistry.set(sessionId, terminal);

    const onData = window.desktopApi.onTerminalData(({ sessionId: targetSessionId, data }) => {
      if (targetSessionId === sessionId) {
        terminal.write(data);
      }
    });

    terminal.onData(data => {
      window.desktopApi.sendInput({ sessionId, data });
    });

    const handlePaste = async event => {
      const pastedFilePaths = window.desktopApi.resolveClipboardFiles(Array.from(event.clipboardData?.files || []));
      if (pastedFilePaths.length > 0) {
        event.preventDefault();
        window.desktopApi.sendInput({ sessionId, data: formatPathsForTerminal(pastedFilePaths) });
        return;
      }

      const text = event.clipboardData?.getData("text/plain");
      if (text) {
        return;
      }

      event.preventDefault();

      try {
        const clipboardText = await window.desktopApi.readClipboardText();
        if (clipboardText) {
          const textPaths = clipboardPathsFromText(clipboardText);
          window.desktopApi.sendInput({
            sessionId,
            data: textPaths.length > 0 ? formatPathsForTerminal(textPaths) : clipboardText,
          });
          return;
        }

        const paths = await window.desktopApi.readClipboardFilePaths();
        if (paths && paths.length > 0) {
          window.desktopApi.sendInput({ sessionId, data: formatPathsForTerminal(paths) });
        }
      } catch {
        // Ignore clipboard failures in the terminal.
      }
    };

    const pasteTarget = terminal.textarea;
    if (pasteTarget) {
      pasteTarget.addEventListener("paste", handlePaste);
    }

    return () => {
      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }

      if (pasteTarget) {
        pasteTarget.removeEventListener("paste", handlePaste);
      }

      onData();
      terminalRegistry.delete(sessionId);
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!active) {
      return undefined;
    }

    const resize = () => {
      if (!activeRef.current || !containerRef.current || !fitRef.current || !terminalRef.current) {
        return;
      }

      const { clientWidth, clientHeight } = containerRef.current;
      if (clientWidth < 120 || clientHeight < 120) {
        return;
      }

      try {
        fitRef.current.fit();

        const nextSize = {
          cols: terminalRef.current.cols,
          rows: terminalRef.current.rows,
        };

        if (nextSize.cols <= 0 || nextSize.rows <= 0) {
          return;
        }

        if (lastResizeRef.current.cols === nextSize.cols && lastResizeRef.current.rows === nextSize.rows) {
          return;
        }

        lastResizeRef.current = nextSize;
        window.desktopApi.resizeSession({
          sessionId,
          cols: nextSize.cols,
          rows: nextSize.rows,
        });
      } catch {
        // Ignore resize noise during teardown.
      }
    };

    const scheduleResize = delay => {
      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current);
      }

      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = null;
        resize();
        if (terminalRef.current) {
          terminalRef.current.focus();
        }
      }, delay);
    };

    const observer = new ResizeObserver(() => {
      scheduleResize(80);
    });

    observer.observe(containerRef.current);
    scheduleResize(40);

    return () => {
      observer.disconnect();
      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
    };
  }, [active, sessionId]);

  return <div className={`terminal-host ${active ? "active" : "hidden"}`} ref={containerRef} />;
}

function StatusBadge({ session }) {
  const status = session.status || "unknown";
  return <span className={`status-badge status-${status}`}>{statusLabel(status)}</span>;
}

function SessionStateDot({ status }) {
  return <span className={`session-state-dot status-${status || "unknown"}`} title={statusLabel(status)} />;
}

function SessionFacts({ session, className = "session-facts" }) {
  const branchDisplay = session.currentBranch || session.branch || "";
  const facts = [session.containerName, branchDisplay ? `branch ${branchDisplay}` : "", session.port ? `port ${session.port}` : ""].filter(Boolean);

  return (
    <div className={className}>
      {facts.map(fact => (
        <span className="session-fact" key={fact}>
          {fact}
        </span>
      ))}
      {session.prNumber ? (
        <span
          className="session-fact session-pr-link"
          onClick={() => window.desktopApi.openExternal(session.prUrl)}
        >
          PR #{session.prNumber}
        </span>
      ) : null}
    </div>
  );
}

function SessionSignal({ state }) {
  if (state === "running") {
    return (
      <span className="session-signal running" title="Background session is active">
        <span className="signal-dot" />
        <span className="signal-dot" />
        <span className="signal-dot" />
      </span>
    );
  }

  if (state === "attention") {
    return <span className="session-signal attention">New output</span>;
  }

  return null;
}

function SessionAvatar({ session }) {
  return <span className={`session-avatar runtime-${session.runtime}`}>{sessionMonogram(session.name)}</span>;
}

function SessionComposerOverlay({ open, sessions, disabled, onClose, onCreate, defaultRuntime }) {
  const [runtime, setRuntime] = useState(defaultRuntime || "claude");

  useEffect(() => {
    if (open && defaultRuntime) {
      setRuntime(defaultRuntime);
    }
  }, [open, defaultRuntime]);
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [port, setPort] = useState("");
  const [showDetails, setShowDetails] = useState(false);

  const normalizedName = useMemo(() => normalizeSessionName(name), [name]);
  const suggestedName = useMemo(() => buildSuggestedSessionName(runtime, sessions, branch), [runtime, sessions, branch]);
  const resolvedName = normalizedName || suggestedName;

  const submitRef = useRef(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    // Auto-focus submit button so Enter works immediately
    setTimeout(() => {
      if (submitRef.current) {
        submitRef.current.focus();
      }
    }, 50);

    const handleKeyDown = event => {
      if (event.key === "Escape") {
        onClose();
        return;
      }

      // Tab toggles between Claude and Codex (unless in an input field)
      if (event.key === "Tab" && event.target.tagName !== "INPUT") {
        event.preventDefault();
        setRuntime(current => (current === "claude" ? "codex" : "claude"));
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  const submit = async event => {
    event.preventDefault();

    await onCreate({
      runtime,
      name: resolvedName,
      branch: branch.trim(),
      port: runtime === "claude" ? port.trim() : "",
    });
  };

  return (
    <div className="overlay-root" role="presentation" onClick={onClose}>
      <div
        aria-labelledby="session-composer-title"
        aria-modal="true"
        className="overlay-card"
        role="dialog"
        onClick={event => event.stopPropagation()}
      >
        <div className="overlay-header">
          <div className="overlay-heading">
            <span className="eyebrow">New session</span>
            <h3 id="session-composer-title">Start fast, customize only if you need to</h3>
          </div>
          <button className="icon-button" type="button" onClick={onClose}>
            x
          </button>
        </div>

        <form className="overlay-form" onSubmit={submit}>
          <div className="runtime-picker" role="tablist" aria-label="Session runtime">
            <button
              aria-selected={runtime === "claude"}
              className={runtime === "claude" ? "runtime-button active" : "runtime-button"}
              type="button"
              onClick={() => setRuntime("claude")}
            >
              <span className="runtime-button-label">Claude</span>
              <span className="runtime-button-copy">Includes optional app port override</span>
            </button>
            <button
              aria-selected={runtime === "codex"}
              className={runtime === "codex" ? "runtime-button active" : "runtime-button"}
              type="button"
              onClick={() => setRuntime("codex")}
            >
              <span className="runtime-button-label">Codex</span>
              <span className="runtime-button-copy">Clean container, branch optional</span>
            </button>
          </div>

          <div className="overlay-preview">
            <div className="overlay-preview-row">
              <span className={`session-avatar runtime-${runtime}`}>{runtime === "claude" ? "CL" : "CX"}</span>
              <div className="overlay-preview-copy">
                <span className="overlay-preview-title">{resolvedName}</span>
                <span className="overlay-preview-text">
                  Starts as {runtimeLabel(runtime)} with project <strong>{`${runtime}-${resolvedName}`}</strong>
                </span>
              </div>
            </div>

            <button
              aria-expanded={showDetails}
              className={showDetails ? "secondary active" : "secondary"}
              type="button"
              onClick={() => setShowDetails(current => !current)}
            >
              {showDetails ? "Hide details" : "Customize"}
            </button>
          </div>

          {showDetails ? (
            <div className="overlay-details">
              <label className="overlay-field">
                <span>Session name</span>
                <input value={name} onChange={event => setName(event.target.value)} placeholder={suggestedName} />
                <small>{name.trim() ? `Saved as ${resolvedName}` : `Defaults to ${suggestedName}`}</small>
              </label>

              <label className="overlay-field">
                <span>Branch</span>
                <input value={branch} onChange={event => setBranch(event.target.value)} placeholder="optional branch" />
                <small>Leave blank to use the default branch for the runtime script.</small>
              </label>

              {runtime === "claude" ? (
                <label className="overlay-field">
                  <span>Port</span>
                  <input value={port} onChange={event => setPort(event.target.value)} placeholder="optional port" />
                  <small>Only used for Claude sessions that need a local dev port override.</small>
                </label>
              ) : null}
            </div>
          ) : null}

          <div className="overlay-footer">
            <button className="secondary" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" type="submit" disabled={disabled} ref={submitRef}>
              {disabled ? "Starting..." : `Start ${runtimeLabel(runtime)}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function App() {
  const [sessions, setSessions] = useState(EMPTY_SESSIONS);
  const [settings, setSettings] = useState({ repoPath: "" });
  const [activeSessionId, setActiveSessionId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showComposer, setShowComposer] = useState(false);
  const [composerRuntime, setComposerRuntime] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }

    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
  });
  const [sessionSignals, setSessionSignals] = useState({});
  const activeSessionIdRef = useRef("");
  const sessionSignalTimersRef = useRef({});

  const activeSession = useMemo(() => sessions.find(session => session.id === activeSessionId), [sessions, activeSessionId]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    const handleKeyDown = event => {
      const key = event.key.toLowerCase();
      const mod = event.metaKey || event.ctrlKey;

      // Cmd+B — toggle sidebar
      if (key === SIDEBAR_SHORTCUT_KEY && mod) {
        event.preventDefault();
        setSidebarCollapsed(current => !current);
        return;
      }

      // Cmd+Shift+C — new Claude session
      if (key === "c" && mod && event.shiftKey) {
        event.preventDefault();
        setComposerRuntime("claude");
        setShowComposer(true);
        return;
      }

      // Cmd+Shift+X — new Codex session
      if (key === "x" && mod && event.shiftKey) {
        event.preventDefault();
        setComposerRuntime("codex");
        setShowComposer(true);
        return;
      }

      // Cmd+N — new session (default)
      if (key === "n" && mod) {
        event.preventDefault();
        setComposerRuntime("");
        setShowComposer(true);
        return;
      }

      // Cmd+[ / Cmd+] — previous/next session
      if ((key === "[" || key === "]") && mod && sessions.length > 0) {
        event.preventDefault();
        const currentIndex = sessions.findIndex(s => s.id === activeSessionIdRef.current);
        let nextIndex;
        if (key === "]") {
          nextIndex = currentIndex < sessions.length - 1 ? currentIndex + 1 : 0;
        } else {
          nextIndex = currentIndex > 0 ? currentIndex - 1 : sessions.length - 1;
        }
        selectSession(sessions[nextIndex].id);
        return;
      }

      // Cmd+1 through Cmd+9 — jump to session by position
      if (mod && !event.shiftKey && event.key >= "1" && event.key <= "9") {
        event.preventDefault();
        const index = parseInt(event.key, 10) - 1;
        if (index < sessions.length) {
          selectSession(sessions[index].id);
        }
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [sessions]);

  useEffect(() => {
    let ignore = false;

    const clearSignalTimer = sessionId => {
      const timer = sessionSignalTimersRef.current[sessionId];
      if (timer) {
        clearTimeout(timer);
        delete sessionSignalTimersRef.current[sessionId];
      }
    };

    const bootstrap = async () => {
      try {
        const [nextSettings, nextSessions] = await Promise.all([window.desktopApi.getSettings(), window.desktopApi.listSessions()]);
        if (ignore) {
          return;
        }

        setSettings(nextSettings);
        setSessions(nextSessions);
      } catch (bootstrapError) {
        if (!ignore) {
          setError(bootstrapError.message || "Failed to load sessions.");
        }
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    };

    bootstrap();

    const offSessions = window.desktopApi.onSessionsChanged(nextSessions => {
      setSessions(nextSessions);
      setSessionSignals(current => {
        const validSessionIds = new Set(nextSessions.map(session => session.id));

        Object.keys(sessionSignalTimersRef.current).forEach(sessionId => {
          if (!validSessionIds.has(sessionId)) {
            clearSignalTimer(sessionId);
          }
        });

        return Object.fromEntries(Object.entries(current).filter(([sessionId]) => validSessionIds.has(sessionId)));
      });

      const currentActive = activeSessionIdRef.current;
      const stillExists = nextSessions.some(session => session.id === currentActive);
      if (!stillExists) {
        setActiveSessionId("");
      }
    });

    const offTerminal = window.desktopApi.onTerminalData(({ sessionId }) => {
      if (sessionId !== activeSessionIdRef.current) {
        clearSignalTimer(sessionId);
        setSessionSignals(current => ({ ...current, [sessionId]: "running" }));
        sessionSignalTimersRef.current[sessionId] = setTimeout(() => {
          setSessionSignals(current => ({ ...current, [sessionId]: "attention" }));
          delete sessionSignalTimersRef.current[sessionId];
        }, 1800);
      }
    });

    const offExit = window.desktopApi.onTerminalExit(({ sessionId }) => {
      if (sessionId !== activeSessionIdRef.current) {
        clearSignalTimer(sessionId);
        setSessionSignals(current => ({ ...current, [sessionId]: "attention" }));
      }
    });

    return () => {
      ignore = true;
      Object.values(sessionSignalTimersRef.current).forEach(clearTimeout);
      sessionSignalTimersRef.current = {};
      offSessions();
      offTerminal();
      offExit();
    };
  }, []);

  const focusTerminal = sessionId => {
    setTimeout(() => {
      const terminal = terminalRegistry.get(sessionId);
      if (terminal) {
        terminal.focus();
      }
    }, 150);
  };

  const selectSession = async sessionId => {
    setActiveSessionId(sessionId);

    const timer = sessionSignalTimersRef.current[sessionId];
    if (timer) {
      clearTimeout(timer);
      delete sessionSignalTimersRef.current[sessionId];
    }

    setSessionSignals(current => {
      if (!current[sessionId]) {
        return current;
      }

      const next = { ...current };
      delete next[sessionId];
      return next;
    });

    // Auto-attach if the session is not already attached
    const session = sessions.find(s => s.id === sessionId);
    if (session && session.status !== "attached") {
      try {
        setBusy(true);
        await window.desktopApi.attachSession({ sessionId });
      } catch {
        // Ignore — session may already be starting or container not ready.
      } finally {
        setBusy(false);
      }
    }

    focusTerminal(sessionId);
  };

  const handleCreate = async payload => {
    try {
      setBusy(true);
      setError("");
      const session = await window.desktopApi.createSession(payload);
      setShowComposer(false);
      selectSession(session.id);
    } catch (createError) {
      setError(createError.message || "Failed to create session.");
    } finally {
      setBusy(false);
    }
  };

  const perform = async (action, payload, onSuccess) => {
    try {
      setBusy(true);
      setError("");
      await action(payload);
      if (onSuccess) {
        onSuccess();
      }
    } catch (actionError) {
      setError(actionError.message || "Action failed.");
    } finally {
      setBusy(false);
    }
  };

  const liveSessionCount = sessions.filter(session => ["attached", "running", "starting"].includes(session.status)).length;

  if (loading) {
    return <div className="boot-screen">Loading desktop workspace...</div>;
  }

  return (
    <>
      <div className={sidebarCollapsed ? "app-shell sidebar-collapsed" : "app-shell"}>
        <aside className="sidebar">
          <div className="sidebar-top">
            {!sidebarCollapsed ? (
              <div className="sidebar-chrome">
                <h1 className="sidebar-title">Sessions</h1>
                <button className="icon-button strong" type="button" onClick={() => setShowComposer(true)} title="New session (Cmd+N)">
                  +
                </button>
              </div>
            ) : (
              <div className="sidebar-chrome compact">
                <button className="icon-button strong" type="button" onClick={() => setShowComposer(true)} title="New session (Cmd+N)">
                  +
                </button>
              </div>
            )}
          </div>

          <div className="session-list-panel">

            <div className="session-list">
              {sessions.length === 0 ? (
                <div className={sidebarCollapsed ? "empty-sidebar compact" : "empty-sidebar"}>
                  <p>No sessions yet.</p>
                  {!sidebarCollapsed ? <p>Use the plus button to start one.</p> : null}
                </div>
              ) : null}

              {sessions.map(session => (
                <button
                  className={session.id === activeSessionId ? "session-item active" : "session-item"}
                  key={session.id}
                  title={sessionTitle(session)}
                  type="button"
                  onClick={() => selectSession(session.id)}
                >
                  <div className="session-item-main">
                    <div className="session-avatar-wrap">
                      <SessionAvatar session={session} />
                      <SessionStateDot status={session.status} />
                    </div>

                    {!sidebarCollapsed ? (
                      <div className="session-copy">
                        <div className="session-title-line">
                          <div className="session-title-block">
                            <span className="session-title">{session.name}</span>
                            <div className="session-meta-text">
                              <span className={`session-runtime runtime-${session.runtime}`}>{runtimeLabel(session.runtime)}</span>
                              {(session.currentBranch || session.branch) ? (
                                <span title="Current git branch">{session.currentBranch || session.branch}</span>
                              ) : null}
                              {session.prNumber ? (
                                <span
                                  className="session-pr-link"
                                  title={`Open PR #${session.prNumber}`}
                                  onClick={e => {
                                    e.stopPropagation();
                                    window.desktopApi.openExternal(session.prUrl);
                                  }}
                                >
                                  PR #{session.prNumber}
                                </span>
                              ) : null}
                              {session.port ? <span>port {session.port}</span> : null}
                            </div>
                          </div>

                          <div className="session-inline-status">
                            <SessionSignal state={sessionSignals[session.id]} />
                          </div>
                        </div>

                        <div className="session-subtle">{session.dockerStatus || "Waiting for container state"}</div>
                      </div>
                    ) : null}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="sidebar-footer">
            <button
              className="prune-button"
              type="button"
              disabled={busy}
              onClick={async () => {
                const confirmed = await window.desktopApi.confirmDialog({
                  message: "Run docker system prune -f?\n\nThis removes unused containers, networks, and dangling images.",
                  buttons: ["Cancel", "Prune"],
                  defaultId: 0,
                });
                if (confirmed) {
                  try {
                    setBusy(true);
                    await window.desktopApi.dockerPrune();
                  } catch (pruneError) {
                    setError(pruneError.message || "Prune failed.");
                  } finally {
                    setBusy(false);
                  }
                }
              }}
              title="Docker system prune"
            >
              {sidebarCollapsed ? "P" : "Prune Docker"}
            </button>
          </div>
        </aside>

        <main className="main-pane">
          {error ? <div className="error-banner">{error}</div> : null}
          {activeSession ? (
            <>
              <header className="main-header">
                <div className="main-heading">
                  <div className="main-heading-top">
                    <SessionAvatar session={activeSession} />
                    <div className="main-heading-copy">
                      <div className="eyebrow">Active session</div>
                      <h2>{activeSession.name}</h2>
                    </div>
                  </div>

                  <div className="header-status-row">
                    <span className={`session-runtime runtime-${activeSession.runtime}`}>{runtimeLabel(activeSession.runtime)}</span>
                    <span className="header-divider" />
                    <StatusBadge session={activeSession} />
                    <span className="header-divider" />
                    <span>{activeSession.dockerStatus || "Ready"}</span>
                  </div>

                  <SessionFacts session={activeSession} className="session-facts detail-facts" />
                </div>

                <div className="action-row">
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => perform(window.desktopApi.resetSession, { sessionId: activeSession.id }, () => focusTerminal(activeSession.id))}
                    disabled={busy}
                  >
                    Reset
                  </button>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => perform(window.desktopApi.stopSession, { sessionId: activeSession.id })}
                    disabled={busy}
                  >
                    Stop
                  </button>
                  <button
                    className="danger"
                    type="button"
                    onClick={() =>
                      perform(window.desktopApi.removeSession, { sessionId: activeSession.id }, () => {
                        setActiveSessionId("");
                      })
                    }
                    disabled={busy}
                  >
                    Remove
                  </button>
                </div>
              </header>

              <section className="terminal-stage">
                <div className="terminal-toolbar">
                  <div className="terminal-toolbar-main">
                    <span className="terminal-shell-dot" />
                    <span className="terminal-shell-dot" />
                    <span className="terminal-shell-dot" />
                    <div className="terminal-label-group">
                      <span className="terminal-shell-label">{runtimeLabel(activeSession.runtime)} session</span>
                      <span className="terminal-shell-meta">{activeSession.containerName}</span>
                    </div>
                  </div>

                  <div className="terminal-toolbar-aside">
                    {(activeSession.currentBranch || activeSession.branch) ? <span className="terminal-chip">branch {activeSession.currentBranch || activeSession.branch}</span> : null}
                    {activeSession.prNumber ? (
                      <span
                        className="terminal-chip session-pr-link"
                        onClick={() => window.desktopApi.openExternal(activeSession.prUrl)}
                      >
                        PR #{activeSession.prNumber}
                      </span>
                    ) : null}
                    {activeSession.port ? <span className="terminal-chip">port {activeSession.port}</span> : null}
                  </div>
                </div>

                {sessions.map(session => (
                  <SessionTerminal key={session.id} sessionId={session.id} active={session.id === activeSessionId} />
                ))}
              </section>
            </>
          ) : (
            <section className="empty-main">
              <div className="empty-panel">
                <div className="empty-mark" />
                <div className="eyebrow">Autodex desktop</div>
                <h2>Let&apos;s build.</h2>
                <p>Keep the terminal front and center. Spin up a fresh Claude or Codex session when you need it.</p>
                <div className="empty-actions">
                  <button className="primary" type="button" onClick={() => setShowComposer(true)}>
                    Start session
                  </button>
                </div>
              </div>
            </section>
          )}
        </main>
      </div>

      <SessionComposerOverlay
        open={showComposer}
        sessions={sessions}
        disabled={busy}
        onClose={() => setShowComposer(false)}
        onCreate={handleCreate}
        defaultRuntime={composerRuntime}
      />
    </>
  );
}
