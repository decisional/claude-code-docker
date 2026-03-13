const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("desktopApi", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  chooseRepoPath: () => ipcRenderer.invoke("settings:choose-repo-path"),
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  createSession: payload => ipcRenderer.invoke("sessions:create", payload),
  attachSession: payload => ipcRenderer.invoke("sessions:attach", payload),
  resetSession: payload => ipcRenderer.invoke("sessions:reset", payload),
  stopSession: payload => ipcRenderer.invoke("sessions:stop", payload),
  removeSession: payload => ipcRenderer.invoke("sessions:remove", payload),
  sendInput: payload => ipcRenderer.invoke("sessions:input", payload),
  resizeSession: payload => ipcRenderer.invoke("sessions:resize", payload),
  readClipboardText: () => ipcRenderer.invoke("clipboard:read-text"),
  readClipboardFilePaths: () => ipcRenderer.invoke("clipboard:read-file-paths"),
  openExternal: url => ipcRenderer.invoke("shell:open-external", url),
  confirmDialog: options => ipcRenderer.invoke("dialog:confirm", options),
  dockerPrune: () => ipcRenderer.invoke("docker:prune"),
  resolveClipboardFiles: files =>
    files
      .map(file => {
        try {
          return webUtils.getPathForFile(file);
        } catch {
          return "";
        }
      })
      .filter(Boolean),
  onTerminalData: handler => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("terminal:data", listener);
    return () => ipcRenderer.removeListener("terminal:data", listener);
  },
  onTerminalExit: handler => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("terminal:exit", listener);
    return () => ipcRenderer.removeListener("terminal:exit", listener);
  },
  onSessionsChanged: handler => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("sessions:changed", listener);
    return () => ipcRenderer.removeListener("sessions:changed", listener);
  },
});
