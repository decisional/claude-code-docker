import { useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

const EMPTY_SESSIONS = [];

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
        background: "#111111",
        foreground: "#e8e6e3",
        cursor: "#ffffff",
        selectionBackground: "#2b2b2b",
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
  return <span className={`status-badge status-${status}`}>{status}</span>;
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
      <button className="primary" type="submit" disabled={disabled || !name.trim()}>
        New session
      </button>
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
  const [unread, setUnread] = useState({});
  const activeSessionIdRef = useRef("");

  const activeSession = useMemo(
    () => sessions.find(session => session.id === activeSessionId),
    [sessions, activeSessionId]
  );

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    let ignore = false;

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
        setUnread(current => ({ ...current, [sessionId]: (current[sessionId] || 0) + 1 }));
      }
    });

    return () => {
      ignore = true;
      offSessions();
      offTerminal();
    };
  }, []);

  const selectSession = sessionId => {
    setActiveSessionId(sessionId);
    setUnread(current => ({ ...current, [sessionId]: 0 }));
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

  if (loading) {
    return <div className="boot-screen">Loading desktop shell…</div>;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div>
            <div className="eyebrow">Claude Code Docker</div>
            <h1>Sessions</h1>
          </div>
          <button className="icon-button" type="button" onClick={() => setShowComposer(current => !current)}>
            +
          </button>
        </div>

        <button className="repo-button" type="button" onClick={chooseRepo}>
          {settings.repoPath || "Choose repository"}
        </button>

        {showComposer ? <NewSessionForm onCreate={handleCreate} disabled={busy} /> : null}

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
              <div className="session-title-row">
                <span className="session-title">{session.name}</span>
                {unread[session.id] ? <span className="unread-pill">{unread[session.id]}</span> : null}
              </div>
              <div className="session-meta">
                <span>{session.runtime}</span>
                <StatusBadge session={session} />
              </div>
              <div className="session-subtle">{session.dockerStatus || session.containerName}</div>
            </button>
          ))}
        </div>
      </aside>

      <main className="main-pane">
        {error ? <div className="error-banner">{error}</div> : null}
        {activeSession ? (
          <>
            <header className="main-header">
              <div>
                <div className="eyebrow">{activeSession.runtime}</div>
                <h2>{activeSession.name}</h2>
                <div className="terminal-subtitle">
                  {activeSession.containerName}
                  {activeSession.branch ? ` • branch ${activeSession.branch}` : ""}
                  {activeSession.port ? ` • port ${activeSession.port}` : ""}
                </div>
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

            <section className="terminal-frame">
              {sessions.map(session => (
                <SessionTerminal key={session.id} sessionId={session.id} active={session.id === activeSessionId} />
              ))}
            </section>
          </>
        ) : (
          <section className="empty-main">
            <div className="empty-panel">
              <div className="eyebrow">Desktop shell</div>
              <h2>Pick a session or create one.</h2>
              <p>This surface keeps all Claude and Codex Docker sessions in one place.</p>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
