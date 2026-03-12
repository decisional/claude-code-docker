import { useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

const EMPTY_SESSIONS = [];

const STATUS_LABELS = {
  attached: "Attached",
  running: "Running",
  starting: "Starting",
  stopped: "Stopped",
  exited: "Stopped",
  detached: "Closed",
  error: "Error",
};

function runtimeLabel(runtime) {
  return runtime === "codex" ? "Codex" : "Claude";
}

function statusLabel(status) {
  return STATUS_LABELS[status] || status || "Unknown";
}

function repoNameFromPath(repoPath) {
  if (!repoPath) {
    return "Choose repository";
  }

  const parts = repoPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || repoPath;
}

function SessionTerminal({ sessionId, active }) {
  const containerRef = useRef(null);
  const terminalRef = useRef(null);
  const fitRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) {
      return undefined;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      theme: {
        background: "#0d0f14",
        foreground: "#eceff4",
        cursor: "#ffffff",
        selectionBackground: "#2d3340",
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

    const onData = window.desktopApi.onTerminalData(({ sessionId: targetSessionId, data }) => {
      if (targetSessionId === sessionId) {
        terminal.write(data);
      }
    });

    const resize = () => {
      try {
        fit.fit();
        window.desktopApi.resizeSession({
          sessionId,
          cols: terminal.cols,
          rows: terminal.rows,
        });
      } catch {
        // Ignore during teardown.
      }
    };

    const observer = new ResizeObserver(resize);
    observer.observe(containerRef.current);
    setTimeout(resize, 50);

    terminal.onData(data => {
      window.desktopApi.sendInput({ sessionId, data });
    });

    return () => {
      observer.disconnect();
      onData();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!active) {
      return;
    }

    setTimeout(() => {
      if (fitRef.current && terminalRef.current) {
        try {
          fitRef.current.fit();
          terminalRef.current.focus();
          window.desktopApi.resizeSession({
            sessionId,
            cols: terminalRef.current.cols,
            rows: terminalRef.current.rows,
          });
        } catch {
          // Ignore.
        }
      }
    }, 25);
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
  const facts = [session.containerName, session.branch ? `branch ${session.branch}` : "", session.port ? `port ${session.port}` : ""].filter(Boolean);

  return (
    <div className={className}>
      {facts.map(fact => (
        <span className="session-fact" key={fact}>
          {fact}
        </span>
      ))}
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

function NewSessionForm({ onCreate, disabled }) {
  const [runtime, setRuntime] = useState("claude");
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [port, setPort] = useState("");

  const submit = async event => {
    event.preventDefault();
    if (!name.trim()) {
      return;
    }

    await onCreate({
      runtime,
      name: name.trim(),
      branch: branch.trim(),
      port: runtime === "claude" ? port.trim() : "",
    });

    setName("");
    setBranch("");
    setPort("");
  };

  return (
    <form className="new-session-form" onSubmit={submit}>
      <div className="field-row">
        <button
          className={runtime === "claude" ? "toggle active" : "toggle"}
          type="button"
          onClick={() => setRuntime("claude")}
        >
          Claude
        </button>
        <button
          className={runtime === "codex" ? "toggle active" : "toggle"}
          type="button"
          onClick={() => setRuntime("codex")}
        >
          Codex
        </button>
      </div>
      <input value={name} onChange={event => setName(event.target.value)} placeholder="session name" />
      <input value={branch} onChange={event => setBranch(event.target.value)} placeholder="branch (optional)" />
      {runtime === "claude" ? (
        <input value={port} onChange={event => setPort(event.target.value)} placeholder="port (optional)" />
      ) : null}
      <div className="composer-footer">
        <div className="composer-hint">
          {runtime === "claude" ? "Optional branch and dev port override." : "Optional branch override for the container."}
        </div>
        <button className="primary" type="submit" disabled={disabled || !name.trim()}>
          Create session
        </button>
      </div>
    </form>
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
  const [sessionSignals, setSessionSignals] = useState({});
  const activeSessionIdRef = useRef("");
  const sessionSignalTimersRef = useRef({});

  const activeSession = useMemo(
    () => sessions.find(session => session.id === activeSessionId),
    [sessions, activeSessionId]
  );

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

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
        if (!activeSessionId && nextSessions[0]) {
          setActiveSessionId(nextSessions[0].id);
        }
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
        setActiveSessionId(nextSessions[0]?.id || "");
      } else if (!currentActive && nextSessions[0]) {
        setActiveSessionId(nextSessions[0].id);
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

  const selectSession = sessionId => {
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

  const chooseRepo = async () => {
    try {
      setBusy(true);
      setError("");
      const nextSettings = await window.desktopApi.chooseRepoPath();
      if (nextSettings) {
        setSettings(nextSettings);
      }
    } catch (chooseError) {
      setError(chooseError.message || "Could not update repository path.");
    } finally {
      setBusy(false);
    }
  };

  const repoName = repoNameFromPath(settings.repoPath);
  const liveSessionCount = sessions.filter(session => ["attached", "running", "starting"].includes(session.status)).length;

  if (loading) {
    return <div className="boot-screen">Loading desktop workspace...</div>;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="sidebar-header">
            <div>
              <div className="eyebrow">Autodex desktop</div>
              <h1>Sessions</h1>
            </div>
            <button
              className={showComposer ? "icon-button active" : "icon-button"}
              type="button"
              onClick={() => setShowComposer(current => !current)}
            >
              {showComposer ? "Close" : "New"}
            </button>
          </div>

          <div className="workspace-row">
            <div className="workspace-copy">
              <span className="repo-label">Workspace</span>
              <span className="repo-name">{repoName}</span>
              <span className="repo-path">{settings.repoPath || "Choose the claude-code-docker repository"}</span>
            </div>
            <button className="repo-button" type="button" onClick={chooseRepo}>
              Change
            </button>
          </div>

          <div className="sidebar-meta">
            <span>{sessions.length} total</span>
            <span>{liveSessionCount} live</span>
          </div>

          {showComposer ? <NewSessionForm onCreate={handleCreate} disabled={busy} /> : null}
        </div>

        <div className="session-list-panel">
          <div className="section-label">All sessions</div>

          <div className="session-list">
            {sessions.length === 0 ? (
              <div className="empty-sidebar">
                <p>No sessions yet.</p>
                <p>Start one with Claude or Codex.</p>
              </div>
            ) : null}

            {sessions.map(session => (
              <button
                className={session.id === activeSessionId ? "session-item active" : "session-item"}
                key={session.id}
                type="button"
                onClick={() => selectSession(session.id)}
              >
                <div className="session-item-main">
                  <div className="session-copy">
                    <div className="session-title-line">
                      <div className="session-title-block">
                        <span className="session-title">{session.name}</span>
                        <div className="session-meta-text">
                          <span className={`session-runtime runtime-${session.runtime}`}>{runtimeLabel(session.runtime)}</span>
                          {session.branch ? <span>branch {session.branch}</span> : null}
                          {session.port ? <span>port {session.port}</span> : null}
                        </div>
                      </div>
                      <div className="session-inline-status">
                        <SessionSignal state={sessionSignals[session.id]} />
                        <SessionStateDot status={session.status} />
                      </div>
                    </div>

                    <div className="session-subtle">{session.dockerStatus || "Waiting for container state"}</div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </aside>

      <main className="main-pane">
        {error ? <div className="error-banner">{error}</div> : null}
        {activeSession ? (
          <>
            <header className="main-header">
              <div className="main-heading">
                <div className="eyebrow">Active session</div>
                <h2>{activeSession.name}</h2>
                <div className="header-status-row">
                  <span className={`session-runtime runtime-${activeSession.runtime}`}>{runtimeLabel(activeSession.runtime)}</span>
                  <span className="header-divider" />
                  <StatusBadge session={activeSession} />
                  <span className="header-divider" />
                  <span>{activeSession.dockerStatus || "Ready"}</span>
                  <span className="header-divider" />
                  <span className="header-path">{settings.repoPath || "Repository not selected"}</span>
                </div>
                <SessionFacts session={activeSession} className="session-facts detail-facts" />
              </div>

              <div className="action-row">
                <button
                  className="secondary"
                  type="button"
                  onClick={() => perform(window.desktopApi.attachSession, { sessionId: activeSession.id }, () => selectSession(activeSession.id))}
                  disabled={busy}
                >
                  Open
                </button>
                <button
                  className="secondary"
                  type="button"
                  onClick={() => perform(window.desktopApi.resetSession, { sessionId: activeSession.id }, () => selectSession(activeSession.id))}
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
                  {activeSession.branch ? <span className="terminal-chip">branch {activeSession.branch}</span> : null}
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
              <p>Open a session from the sidebar or start a new one.</p>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
