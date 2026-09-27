const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const electronDir = path.join(__dirname, "..", "electron");

// Exercise the real IPC handler, state persistence, and refresh logic without
// opening Electron or touching the user's Docker containers or desktop state.
async function desktopHarness(t) {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-rename-test-"));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const handlers = new Map();
  const context = vm.createContext({
    require(name) {
      if (name === "electron") return {
        app: { getPath: () => userData, whenReady: () => new Promise(() => {}), on() {} },
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
        powerMonitor: { on() {} },
      };
      if (name === "node-pty") return {};
      return require(name);
    },
    __dirname: electronDir,
    process,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  vm.runInContext(await fs.readFile(path.join(electronDir, "main.cjs"), "utf8"), context);
  const run = code => vm.runInContext(code, context);
  await run("ensureStateLoaded()");
  run(`
    upsertSession({ id: "claude:session-01", name: "session-01", runtime: "claude",
      containerName: "claude-session-01-claude-code-1", status: "running", threadTitle: "Automatic title" });
    getDockerContainers = async () => [{ name: "claude-session-01-claude-code-1", state: "running", status: "Up 1 hour" }];
    getContainerGitInfo = async () => ({ branch: "main", repoSlug: "" });
    getPrForBranch = async () => null;
    getContainerDiffStats = async () => ({});
    getContainerThreadTitle = async () => "Updated automatic title";
  `);
  return {
    run,
    rename: title => handlers.get("sessions:rename")({}, { sessionId: "claude:session-01", title }),
    session: () => JSON.parse(run('JSON.stringify(getSessionById("claude:session-01"))')),
  };
}

test("manual names persist across refresh, stale lifecycle updates, and app restarts", async t => {
  const desktop = await desktopHarness(t);
  await desktop.run("refreshSessionsFromDocker()");
  assert.equal(desktop.session().threadTitle, "Updated automatic title");
  assert.equal(desktop.session().customTitle, undefined);
  desktop.run('globalThis.staleSession = { ...getSessionById("claude:session-01") }');
  await desktop.rename("  My important task 🚀  ");
  desktop.run("upsertSession({ ...staleSession, status: 'attached' })");
  await desktop.run("refreshSessionsFromDocker()");
  assert.equal(desktop.session().customTitle, "My important task 🚀");
  assert.equal(desktop.session().name, "session-01");
  assert.equal(desktop.session().containerName, "claude-session-01-claude-code-1");
  await desktop.run('storePath = ""; ensureStateLoaded()');
  assert.equal(desktop.session().customTitle, "My important task 🚀");
  await desktop.rename("A second manual name");
  assert.equal(desktop.session().customTitle, "A second manual name");
});

test("an in-flight refresh cannot overwrite a newer manual rename", async t => {
  const desktop = await desktopHarness(t);
  desktop.run(`
    globalThis.queryStarted = new Promise(resolve => globalThis.markStarted = resolve);
    getContainerGitInfo = () => { markStarted(); return new Promise(resolve => globalThis.finishQuery = resolve); };
  `);
  const refresh = desktop.run("refreshSessionsFromDocker()");
  await desktop.run("queryStarted");
  // Simulate attach/reset replacing the object held by the pending refresh.
  desktop.run('upsertSession({ id: "claude:session-01", status: "attached" })');
  await desktop.rename("Keep this title");
  desktop.run('finishQuery({ branch: "main", repoSlug: "" })');
  await refresh;
  assert.equal(desktop.session().customTitle, "Keep this title");
});

test("invalid names are rejected and removing a session discards its manual name", async t => {
  const desktop = await desktopHarness(t);
  await desktop.rename("Saved name");
  for (const title of ["", "   ", "line\nbreak", "control\x00character", "x".repeat(201), null, 42]) {
    await assert.rejects(desktop.rename(title), /1–200 characters/);
    assert.equal(desktop.session().customTitle, "Saved name");
  }
  desktop.run('removeSessionById("claude:session-01")');
  await assert.rejects(desktop.rename("Too late"), /no longer exists/);
  await desktop.run("refreshSessionsFromDocker()");
  assert.equal(desktop.session().customTitle, undefined);
});
