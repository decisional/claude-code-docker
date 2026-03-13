import { useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

const EMPTY_SESSIONS = [];
// Registry so parent can focus a terminal by session ID
const terminalRegistry = new Map();
const SIDEBAR_STORAGE_KEY = "autodex-desktop:sidebar-collapsed";
const REVIEW_PANEL_STORAGE_KEY = "autodex-desktop:review-panel-open";
const LINEAR_KEY_STORAGE_KEY = "autodex-desktop:linear-configured";
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
      allowProposedApi: true,
      theme: {
        background: "#1a1d1a",
        foreground: "#e8e8e6",
        cursor: "#8bc48b",
        selectionBackground: "rgba(139, 196, 139, 0.35)",
        black: "#1a1d1a",
        brightBlack: "#4a4a46",
        white: "#e8e8e6",
        brightWhite: "#f5f5f3",
        green: "#8bc48b",
        brightGreen: "#6db86d",
        yellow: "#d4a843",
        brightYellow: "#e0be6a",
        red: "#d46a6a",
        brightRed: "#e08888",
        blue: "#60a5fa",
        brightBlue: "#93c5fd",
        cyan: "#5eead4",
        brightCyan: "#99f6e4",
        magenta: "#c084fc",
        brightMagenta: "#d8b4fe",
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

    // Strip mouse-mode enable sequences so xterm.js never captures mouse
    // events from the app (Claude Code / Codex TUI). This keeps text
    // selection and copy working at all times.
    const MOUSE_MODE_RE = /\x1b\[\?(?:9|1000|1002|1003|1004|1005|1006|1015|1016)h/g;

    const onData = window.desktopApi.onTerminalData(({ sessionId: targetSessionId, data }) => {
      if (targetSessionId === sessionId) {
        terminal.write(typeof data === "string" ? data.replace(MOUSE_MODE_RE, "") : data);
      }
    });

    terminal.onData(data => {
      window.desktopApi.sendInput({ sessionId, data });
    });

    // Cmd+C copies selection when text is selected, otherwise sends SIGINT
    terminal.attachCustomKeyEventHandler(event => {
      if ((event.metaKey || event.ctrlKey) && event.key === "c" && event.type === "keydown") {
        const selection = terminal.getSelection();
        if (selection) {
          window.desktopApi.writeClipboardText(selection);
          terminal.clearSelection();
          return false; // Prevent sending Ctrl+C to the terminal
        }
      }
      return true;
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
        // Check for an image in the clipboard (e.g. screenshot Cmd+V)
        const imagePath = await window.desktopApi.readClipboardImage(sessionId);
        if (imagePath) {
          window.desktopApi.sendInput({ sessionId, data: formatPathsForTerminal([imagePath]) });
          return;
        }

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

function CopyPromptButton({ prompt }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async e => {
    e.stopPropagation();
    await window.desktopApi.writeClipboardText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button className={`terminal-chip copy-prompt-btn ${copied ? "copied" : ""}`} type="button" onClick={handleCopy} title="Copy ticket prompt to clipboard">
      {copied ? (
        <>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          Copied
        </>
      ) : (
        <>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" /><path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" stroke="currentColor" strokeWidth="1.2" /></svg>
          Copy Prompt
        </>
      )}
    </button>
  );
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
        <>
          <span
            className="session-fact session-pr-link"
            onClick={() => window.desktopApi.openExternal(session.prUrl)}
          >
            PR #{session.prNumber}
          </span>
          {session.repoSlug ? (
            <span
              className="session-fact session-pr-link devin-link"
              onClick={() => window.desktopApi.openExternal(`https://app.devin.ai/review/${session.repoSlug}/pull/${session.prNumber}`)}
            >
              Devin
            </span>
          ) : null}
        </>
      ) : null}
      {session.linearTicketId ? (
        <span
          className="session-fact session-linear-link"
          onClick={() => session.linearTicketUrl && window.desktopApi.openExternal(session.linearTicketUrl)}
        >
          {session.linearTicketId}
        </span>
      ) : null}
    </div>
  );
}

function parseDiff(rawDiff) {
  if (!rawDiff || !rawDiff.trim()) return [];
  const lines = rawDiff.split("\n");
  const hunks = [];
  let currentHunk = null;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      currentHunk = {
        header: line,
        context: match ? match[3].trim() : "",
        oldStart: match ? parseInt(match[1], 10) : 0,
        newStart: match ? parseInt(match[2], 10) : 0,
        lines: [],
      };
      hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      currentHunk.lines.push({ type: "add", content: line.slice(1) });
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ type: "del", content: line.slice(1) });
    } else if (line.startsWith(" ") || line === "") {
      currentHunk.lines.push({ type: "ctx", content: line.slice(1) || "" });
    }
  }

  return hunks;
}

function fileIcon(filePath) {
  const ext = filePath.split(".").pop();
  const dirPart = filePath.includes("/");
  if (["ts", "tsx", "js", "jsx"].includes(ext)) return "code";
  if (["css", "scss", "less"].includes(ext)) return "style";
  if (["json", "yaml", "yml", "toml"].includes(ext)) return "config";
  if (["md", "txt", "rst"].includes(ext)) return "doc";
  if (ext === "lock") return "lock";
  return dirPart ? "file" : "file";
}

function fileName(filePath) {
  return filePath.split("/").pop() || filePath;
}

function fileDir(filePath) {
  const parts = filePath.split("/");
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/");
}

function DiffViewer({ hunks }) {
  if (!hunks || hunks.length === 0) {
    return <div className="diff-empty">No changes</div>;
  }

  let oldLine = 0;
  let newLine = 0;

  return (
    <div className="diff-viewer">
      {hunks.map((hunk, hunkIndex) => {
        oldLine = hunk.oldStart;
        newLine = hunk.newStart;

        return (
          <div className="diff-hunk" key={hunkIndex}>
            <div className="diff-hunk-header">{hunk.header}</div>
            {hunk.lines.map((line, lineIndex) => {
              let oldNum = "";
              let newNum = "";

              if (line.type === "ctx") {
                oldNum = oldLine++;
                newNum = newLine++;
              } else if (line.type === "add") {
                newNum = newLine++;
              } else if (line.type === "del") {
                oldNum = oldLine++;
              }

              return (
                <div className={`diff-line diff-${line.type}`} key={`${hunkIndex}-${lineIndex}`}>
                  <span className="diff-line-num old">{oldNum}</span>
                  <span className="diff-line-num new">{newNum}</span>
                  <span className="diff-line-marker">{line.type === "add" ? "+" : line.type === "del" ? "-" : " "}</span>
                  <span className="diff-line-content">{line.content}</span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function ReviewPanel({ session, onClose }) {
  const [diffFiles, setDiffFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileDiff, setFileDiff] = useState("");
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);

  useEffect(() => {
    if (!session) return;

    let cancelled = false;
    setLoadingFiles(true);

    window.desktopApi.getDiffFiles({ sessionId: session.id }).then(result => {
      if (cancelled) return;
      setDiffFiles(result.files || []);
      setLoadingFiles(false);
      if (result.files && result.files.length > 0 && !selectedFile) {
        setSelectedFile(result.files[0].path);
      }
    }).catch(() => {
      if (!cancelled) setLoadingFiles(false);
    });

    return () => { cancelled = true; };
  }, [session?.id]);

  useEffect(() => {
    if (!session || !selectedFile) return;

    let cancelled = false;
    setLoadingDiff(true);

    window.desktopApi.getFileDiff({ sessionId: session.id, filePath: selectedFile }).then(result => {
      if (cancelled) return;
      setFileDiff(result || "");
      setLoadingDiff(false);
    }).catch(() => {
      if (!cancelled) setLoadingDiff(false);
    });

    return () => { cancelled = true; };
  }, [session?.id, selectedFile]);

  const hunks = useMemo(() => parseDiff(fileDiff), [fileDiff]);
  const branchDisplay = session?.currentBranch || session?.branch || "";
  const totalAdd = diffFiles.reduce((s, f) => s + f.additions, 0);
  const totalDel = diffFiles.reduce((s, f) => s + f.deletions, 0);

  // Build file tabs - show first 3, then "+N more"
  const visibleTabs = diffFiles.slice(0, 3);
  const remainingCount = diffFiles.length - 3;

  return (
    <aside className="review-panel">
      <div className="review-panel-header">
        <div className="review-panel-title">
          <svg className="review-panel-icon" width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M5.5 3.5L2 7l3.5 3.5M10.5 3.5L14 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>Review Changes</span>
          {session?.prNumber ? (
            <span
              className="review-pr-badge"
              onClick={() => window.desktopApi.openExternal(session.prUrl)}
            >
              PR #{session.prNumber}
            </span>
          ) : null}
        </div>
        <button className="icon-button" type="button" onClick={onClose} title="Close review panel">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {selectedFile ? (
        <>
          <div className="review-file-tabs">
            {visibleTabs.map(file => (
              <button
                className={`review-file-tab ${file.path === selectedFile ? "active" : ""}`}
                key={file.path}
                onClick={() => setSelectedFile(file.path)}
                title={file.path}
              >
                {fileName(file.path)}
              </button>
            ))}
            {remainingCount > 0 ? (
              <span className="review-file-tab more">+{remainingCount} more</span>
            ) : null}
          </div>

          <div className="review-diff-area">
            {loadingDiff ? (
              <div className="diff-loading">Loading diff...</div>
            ) : (
              <DiffViewer hunks={hunks} />
            )}
          </div>
        </>
      ) : (
        <div className="review-file-list">
          {loadingFiles ? (
            <div className="diff-loading">Loading changes...</div>
          ) : diffFiles.length === 0 ? (
            <div className="diff-empty">No changes detected</div>
          ) : (
            <>
              <div className="review-file-list-header">
                <span className="review-file-count">{diffFiles.length} changed files</span>
                <span className="review-stats-total">
                  <span className="diff-stat-add">+{totalAdd}</span>
                  <span className="diff-stat-del">-{totalDel}</span>
                </span>
              </div>
              {diffFiles.map(file => (
                <button
                  className="review-file-item"
                  key={file.path}
                  onClick={() => setSelectedFile(file.path)}
                >
                  <span className="review-file-icon">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                      <path d="M4 2h5.5L13 5.5V13a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.2" />
                      <path d="M9 2v4h4" stroke="currentColor" strokeWidth="1.2" />
                    </svg>
                  </span>
                  <div className="review-file-info">
                    <span className="review-file-name">{fileName(file.path)}</span>
                    {fileDir(file.path) ? <span className="review-file-dir">{fileDir(file.path)}</span> : null}
                  </div>
                  <span className="review-file-stats">
                    {file.additions > 0 ? <span className="diff-stat-add">+{file.additions}</span> : null}
                    {file.deletions > 0 ? <span className="diff-stat-del">-{file.deletions}</span> : null}
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {selectedFile ? (
        <div className="review-panel-footer">
          <button className="review-back-btn" type="button" onClick={() => setSelectedFile(null)}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M10 12L6 8l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            All files
          </button>
          <span className="review-current-file">{fileName(selectedFile)}</span>
        </div>
      ) : null}
    </aside>
  );
}

function SessionSignal({ state }) {
  if (state === "running") {
    return (
      <span className="session-signal running" title="Session is active">
        <span className="signal-grid">
          <span className="signal-dot" />
          <span className="signal-dot" />
          <span className="signal-dot" />
          <span className="signal-dot" />
          <span className="signal-dot" />
          <span className="signal-dot" />
        </span>
      </span>
    );
  }

  if (state === "attention") {
    return (
      <span className="session-signal attention" title="Needs review">
        <span className="signal-attention-dot" />
      </span>
    );
  }

  return null;
}

function SessionAvatar({ session }) {
  return (
    <span className={`session-avatar runtime-${session.runtime}`}>
      {session.runtime === "codex" ? (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M5 4l-3 4 3 4M11 4l3 4-3 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M4 12l3-4-3-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M8.5 12h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )}
    </span>
  );
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

function LinearSettingsOverlay({ open, onClose, settings, onSave }) {
  const [apiKey, setApiKey] = useState("");
  const [project, setProject] = useState("");
  const [projects, setProjects] = useState([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState(null);

  useEffect(() => {
    if (open) {
      setApiKey(settings.linearApiKey || "");
      setProject(settings.linearProject || "");
      setTestResult(null);
    }
  }, [open, settings.linearApiKey, settings.linearProject]);

  // Fetch projects when the overlay opens and we have a key
  useEffect(() => {
    if (!open || !settings.linearApiKey) return;
    setLoadingProjects(true);
    window.desktopApi.getLinearProjects()
      .then(result => { setProjects(result); setLoadingProjects(false); })
      .catch(() => setLoadingProjects(false));
  }, [open, settings.linearApiKey]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = event => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const handleSave = async () => {
    setSaving(true);
    setTestResult(null);
    try {
      await onSave({ linearApiKey: apiKey.trim(), linearProject: project });
      onClose();
    } catch (err) {
      setTestResult({ ok: false, message: err.message || "Failed to save." });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setSaving(true);
    setTestResult(null);
    try {
      // Save first, then test by fetching tickets
      await onSave({ linearApiKey: apiKey.trim(), linearProject: project });
      const result = await window.desktopApi.getLinearTickets();
      setTestResult({ ok: true, message: `Connected as ${result.viewer.name} (${result.viewer.email}). Found ${result.tickets.length} To Do tickets.` });
    } catch (err) {
      setTestResult({ ok: false, message: err.message || "Connection failed." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overlay-root" role="presentation" onClick={onClose}>
      <div className="overlay-card" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        <div className="overlay-header">
          <div className="overlay-heading">
            <span className="eyebrow">Settings</span>
            <h3>Linear Integration</h3>
          </div>
          <button className="icon-button" type="button" onClick={onClose}>x</button>
        </div>

        <div className="overlay-form">
          <label className="overlay-field">
            <span>Linear API Key</span>
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="lin_api_..."
            />
            <small>Generate a personal API key from Linear Settings &gt; API.</small>
          </label>

          <label className="overlay-field">
            <span>Project Filter</span>
            <select
              value={project}
              onChange={e => setProject(e.target.value)}
              className="linear-select"
            >
              <option value="">All projects</option>
              {loadingProjects ? (
                <option disabled>Loading projects...</option>
              ) : (
                projects.map(p => (
                  <option key={p.id} value={p.name}>{p.name}</option>
                ))
              )}
            </select>
            <small>Only show To Do tickets from this project.</small>
          </label>

          {testResult ? (
            <div className={testResult.ok ? "linear-test-ok" : "error-banner"}>
              {testResult.message}
            </div>
          ) : null}

          <div className="overlay-footer">
            <button className="secondary" type="button" onClick={handleTest} disabled={saving || !apiKey.trim()}>
              {saving ? "Testing..." : "Test Connection"}
            </button>
            <button className="primary" type="button" onClick={handleSave} disabled={saving || !apiKey.trim()}>
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function LinearTicketBrowser({ open, onClose, sessions, busy, onCreateSession, onOpenSettings }) {
  const [tickets, setTickets] = useState([]);
  const [viewer, setViewer] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedRuntime, setSelectedRuntime] = useState("claude");
  const [submitting, setSubmitting] = useState(false);
  const submitRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError("");
    setCurrentIndex(0);
    setTickets([]);
    setViewer(null);

    window.desktopApi.getLinearTickets()
      .then(result => {
        setTickets(result.tickets);
        setViewer(result.viewer);
        setLoading(false);
        // Auto-focus submit after tickets load
        setTimeout(() => { if (submitRef.current) submitRef.current.focus(); }, 100);
      })
      .catch(err => {
        setError(err.message || "Failed to fetch tickets.");
        setLoading(false);
      });
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = event => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      // Tab toggles between Claude and Codex
      if (event.key === "Tab") {
        event.preventDefault();
        setSelectedRuntime(r => (r === "claude" ? "codex" : "claude"));
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const ticket = tickets[currentIndex];

  const handleSkip = () => {
    if (currentIndex < tickets.length - 1) {
      setCurrentIndex(i => i + 1);
    }
  };

  const handlePrev = () => {
    if (currentIndex > 0) {
      setCurrentIndex(i => i - 1);
    }
  };

  const handleSubmit = async () => {
    if (!ticket) return;
    setSubmitting(true);
    try {
      const sessionName = normalizeSessionName(ticket.identifier);
      const ticketPayload = {
        id: ticket.id,
        identifier: ticket.identifier,
        title: ticket.title,
        description: ticket.description || "",
        url: ticket.url,
        comments: (ticket.comments?.nodes || []).map(c => ({
          user: c.user?.name || "Unknown",
          body: c.body,
        })),
      };

      await onCreateSession({
        runtime: selectedRuntime,
        name: buildSuggestedSessionName(selectedRuntime, sessions, sessionName),
        ticket: ticketPayload,
      });
      // Move to next ticket or close if done
      if (currentIndex < tickets.length - 1) {
        setCurrentIndex(i => i + 1);
      } else {
        onClose();
      }
    } catch (err) {
      setError(err.message || "Failed to create session.");
    } finally {
      setSubmitting(false);
    }
  };

  const priorityLabel = p => {
    const labels = { 0: "No priority", 1: "Urgent", 2: "High", 3: "Medium", 4: "Low" };
    return labels[p] || "";
  };

  return (
    <div className="overlay-root" role="presentation" onClick={onClose}>
      <div className="overlay-card linear-ticket-card" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        <div className="overlay-header">
          <div className="overlay-heading">
            <span className="eyebrow">Linear Pipeline {viewer ? `\u2014 ${viewer.name}` : ""}</span>
            <h3>To Do Tickets {tickets.length > 0 ? `(${currentIndex + 1} of ${tickets.length})` : ""}</h3>
          </div>
          <button className="icon-button" type="button" onClick={onClose}>x</button>
        </div>

        {loading ? (
          <div className="linear-loading">Loading tickets from Linear...</div>
        ) : error ? (
          <div className="linear-error-section">
            <div className="error-banner">{error}</div>
            {error.includes("API key") ? (
              <button className="primary" type="button" onClick={() => { onClose(); onOpenSettings(); }} style={{ marginTop: 12 }}>
                Configure API Key
              </button>
            ) : null}
          </div>
        ) : tickets.length === 0 ? (
          <div className="linear-empty">No To Do tickets found assigned to you.</div>
        ) : ticket ? (
          <div className="linear-ticket-content">
            <div className="linear-ticket-header">
              <span className="linear-ticket-id">{ticket.identifier}</span>
              <span className={`linear-priority priority-${ticket.priority}`}>{priorityLabel(ticket.priority)}</span>
              {ticket.labels?.nodes?.map(l => (
                <span className="linear-label" key={l.name}>{l.name}</span>
              ))}
            </div>

            <h4 className="linear-ticket-title">{ticket.title}</h4>

            {ticket.description ? (
              <div className="linear-ticket-desc">{ticket.description}</div>
            ) : null}

            {ticket.comments?.nodes?.length > 0 ? (
              <div className="linear-ticket-comments">
                <span className="linear-comments-label">Comments ({ticket.comments.nodes.length})</span>
                {ticket.comments.nodes.slice(0, 5).map((c, i) => (
                  <div className="linear-comment" key={i}>
                    <span className="linear-comment-author">{c.user?.name || "Unknown"}</span>
                    <span className="linear-comment-body">{c.body}</span>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="linear-ticket-url">
              <span
                className="session-pr-link"
                onClick={() => window.desktopApi.openExternal(ticket.url)}
              >
                Open in Linear
              </span>
            </div>

            <div className="linear-runtime-pick">
              <span className="overlay-field-label">Run with:</span>
              <div className="runtime-picker">
                <button
                  className={selectedRuntime === "claude" ? "runtime-button active" : "runtime-button"}
                  type="button"
                  onClick={() => setSelectedRuntime("claude")}
                >
                  <span className="runtime-button-label">Claude</span>
                </button>
                <button
                  className={selectedRuntime === "codex" ? "runtime-button active" : "runtime-button"}
                  type="button"
                  onClick={() => setSelectedRuntime("codex")}
                >
                  <span className="runtime-button-label">Codex</span>
                </button>
              </div>
            </div>

            <div className="linear-ticket-actions">
              <button className="secondary" type="button" onClick={handlePrev} disabled={currentIndex === 0}>
                Previous
              </button>
              <button className="secondary" type="button" onClick={handleSkip} disabled={currentIndex >= tickets.length - 1}>
                Skip
              </button>
              <button className="primary" type="button" onClick={handleSubmit} disabled={submitting || busy} ref={submitRef}>
                {submitting ? "Starting..." : `Start ${runtimeLabel(selectedRuntime)}`}
              </button>
            </div>
          </div>
        ) : null}

        <div className="linear-ticket-nav">
          <button className="secondary" type="button" onClick={onClose}>
            Done
          </button>
        </div>
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
  const [reviewPanelOpen, setReviewPanelOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(REVIEW_PANEL_STORAGE_KEY) === "true";
  });
  const [showLinearSettings, setShowLinearSettings] = useState(false);
  const [showLinearBrowser, setShowLinearBrowser] = useState(false);
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
    window.localStorage.setItem(REVIEW_PANEL_STORAGE_KEY, String(reviewPanelOpen));
  }, [reviewPanelOpen]);

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

      // Cmd+Shift+C — quick-create Claude session (skip form)
      if (key === "c" && mod && event.shiftKey) {
        event.preventDefault();
        handleCreate({
          runtime: "claude",
          name: buildSuggestedSessionName("claude", sessions),
          branch: "",
          port: "",
        });
        return;
      }

      // Cmd+Shift+X — quick-create Codex session (skip form)
      if (key === "x" && mod && event.shiftKey) {
        event.preventDefault();
        handleCreate({
          runtime: "codex",
          name: buildSuggestedSessionName("codex", sessions),
          branch: "",
          port: "",
        });
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

  const handleCreateWithTicket = async payload => {
    try {
      setBusy(true);
      setError("");
      const session = await window.desktopApi.createSessionWithTicket(payload);
      selectSession(session.id);
    } catch (createError) {
      setError(createError.message || "Failed to create session with ticket.");
      throw createError;
    } finally {
      setBusy(false);
    }
  };

  const handleSaveLinearSettings = async payload => {
    const result = await window.desktopApi.saveLinearSettings(payload);
    setSettings(result);
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
      <div className={[
        "app-shell",
        sidebarCollapsed && "sidebar-collapsed",
        reviewPanelOpen && activeSession && "review-open",
      ].filter(Boolean).join(" ")}>
        <aside className="sidebar">
          <div className="sidebar-top">
            {!sidebarCollapsed ? (
              <div className="sidebar-chrome">
                <button
                  className="icon-button collapse-toggle"
                  type="button"
                  onClick={() => setSidebarCollapsed(true)}
                  title="Collapse sidebar (Cmd+B)"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M10 12L6 8l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <h1 className="sidebar-title">Sessions</h1>
                <button className="icon-button new-session-btn" type="button" onClick={() => setShowComposer(true)} title="New session (Cmd+N)">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            ) : (
              <div className="sidebar-chrome compact">
                <button
                  className="icon-button collapse-toggle"
                  type="button"
                  onClick={() => setSidebarCollapsed(false)}
                  title="Expand sidebar (Cmd+B)"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <button className="icon-button new-session-btn" type="button" onClick={() => setShowComposer(true)} title="New session (Cmd+N)">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
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
                  className={[
                    "session-item",
                    session.id === activeSessionId && "active",
                    sessionSignals[session.id] === "attention" && "attention",
                    sessionSignals[session.id] === "running" && "has-output",
                  ].filter(Boolean).join(" ")}
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
                            <div className="session-title-row">
                              <span className="session-title">{session.threadTitle || session.name}</span>
                              {session.diffStats && (session.diffStats.totalAdditions > 0 || session.diffStats.totalDeletions > 0) ? (
                                <span className="session-diff-stats">
                                  {session.diffStats.totalAdditions > 0 ? <span className="diff-stat-add">+{session.diffStats.totalAdditions}</span> : null}
                                  {session.diffStats.totalDeletions > 0 ? <span className="diff-stat-del">-{session.diffStats.totalDeletions}</span> : null}
                                </span>
                              ) : null}
                            </div>
                            <div className="session-meta-text">
                              <span className={`session-runtime runtime-${session.runtime}`}>{runtimeLabel(session.runtime)}</span>
                              {(session.currentBranch || session.branch) ? (
                                <span title="Current git branch">{session.currentBranch || session.branch}</span>
                              ) : null}
                              {session.prNumber ? (
                                <>
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
                                  {session.repoSlug ? (
                                    <span
                                      className="session-pr-link devin-link"
                                      title="Open in Devin"
                                      onClick={e => {
                                        e.stopPropagation();
                                        window.desktopApi.openExternal(`https://app.devin.ai/review/${session.repoSlug}/pull/${session.prNumber}`);
                                      }}
                                    >
                                      Devin
                                    </span>
                                  ) : null}
                                </>
                              ) : null}
                              {session.port ? <span>port {session.port}</span> : null}
                              {session.linearTicketId ? (
                                <span
                                  className="session-linear-link"
                                  title={`Open ${session.linearTicketId} in Linear`}
                                  onClick={e => {
                                    e.stopPropagation();
                                    if (session.linearTicketUrl) {
                                      window.desktopApi.openExternal(session.linearTicketUrl);
                                    }
                                  }}
                                >
                                  {session.linearTicketId}
                                </span>
                              ) : null}
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
              className="linear-pipeline-button"
              type="button"
              disabled={busy}
              onClick={() => setShowLinearBrowser(true)}
              title="Linear ticket pipeline"
            >
              {sidebarCollapsed ? (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                  Linear Pipeline
                </>
              )}
            </button>
            {!sidebarCollapsed ? (
              <button
                className="linear-settings-link"
                type="button"
                onClick={() => setShowLinearSettings(true)}
                title="Linear settings"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <path d="M8 10a2 2 0 100-4 2 2 0 000 4z" stroke="currentColor" strokeWidth="1.2" />
                  <path d="M13.5 8a5.5 5.5 0 01-11 0 5.5 5.5 0 0111 0z" stroke="currentColor" strokeWidth="1.2" />
                </svg>
              </button>
            ) : null}
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
                      <div className="eyebrow">{activeSession.name}</div>
                      <h2>{activeSession.threadTitle || activeSession.name}</h2>
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
                      <>
                        <span
                          className="terminal-chip session-pr-link"
                          onClick={() => window.desktopApi.openExternal(activeSession.prUrl)}
                        >
                          PR #{activeSession.prNumber}
                        </span>
                        {activeSession.repoSlug ? (
                          <span
                            className="terminal-chip session-pr-link devin-link"
                            onClick={() => window.desktopApi.openExternal(`https://app.devin.ai/review/${activeSession.repoSlug}/pull/${activeSession.prNumber}`)}
                          >
                            Devin
                          </span>
                        ) : null}
                      </>
                    ) : null}
                    {activeSession.port ? <span className="terminal-chip">port {activeSession.port}</span> : null}
                    {activeSession.linearTicketId ? (
                      <>
                        <span
                          className="terminal-chip session-linear-link"
                          onClick={() => activeSession.linearTicketUrl && window.desktopApi.openExternal(activeSession.linearTicketUrl)}
                        >
                          {activeSession.linearTicketId}
                        </span>
                        {activeSession.linearTicketPrompt ? (
                          <CopyPromptButton prompt={activeSession.linearTicketPrompt} />
                        ) : null}
                      </>
                    ) : null}
                    <button
                      className={`terminal-chip review-toggle ${reviewPanelOpen ? "active" : ""}`}
                      type="button"
                      onClick={() => setReviewPanelOpen(current => !current)}
                      title="Toggle review panel"
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                        <path d="M5.5 3.5L2 7l3.5 3.5M10.5 3.5L14 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      Changes
                    </button>
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

        {reviewPanelOpen && activeSession ? (
          <ReviewPanel session={activeSession} onClose={() => setReviewPanelOpen(false)} />
        ) : null}
      </div>

      <SessionComposerOverlay
        open={showComposer}
        sessions={sessions}
        disabled={busy}
        onClose={() => setShowComposer(false)}
        onCreate={handleCreate}
        defaultRuntime={composerRuntime}
      />

      <LinearSettingsOverlay
        open={showLinearSettings}
        onClose={() => setShowLinearSettings(false)}
        settings={settings}
        onSave={handleSaveLinearSettings}
      />

      <LinearTicketBrowser
        open={showLinearBrowser}
        onClose={() => setShowLinearBrowser(false)}
        sessions={sessions}
        busy={busy}
        onCreateSession={handleCreateWithTicket}
        onOpenSettings={() => setShowLinearSettings(true)}
      />
    </>
  );
}
