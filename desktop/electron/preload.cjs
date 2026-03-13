const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("desktopApi", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  chooseRepoPath: () => ipcRenderer.invoke("settings:choose-repo-path"),
  saveLinearSettings: payload => ipcRenderer.invoke("linear:save-settings", payload),
  getLinearTickets: () => ipcRenderer.invoke("linear:get-tickets"),
  createSessionWithTicket: payload => ipcRenderer.invoke("sessions:create-with-ticket", payload),
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  createSession: payload => ipcRenderer.invoke("sessions:create", payload),
  attachSession: payload => ipcRenderer.invoke("sessions:attach", payload),
  resetSession: payload => ipcRenderer.invoke("sessions:reset", payload),
  stopSession: payload => ipcRenderer.invoke("sessions:stop", payload),
  removeSession: payload => ipcRenderer.invoke("sessions:remove", payload),
  sendInput: payload => ipcRenderer.invoke("sessions:input", payload),
  resizeSession: payload => ipcRenderer.invoke("sessions:resize", payload),
  readClipboardText: () => ipcRenderer.invoke("clipboard:read-text"),
  writeClipboardText: text => ipcRenderer.invoke("clipboard:write-text", text),
  readClipboardFilePaths: () => ipcRenderer.invoke("clipboard:read-file-paths"),
  openExternal: url => ipcRenderer.invoke("shell:open-external", url),
  confirmDialog: options => ipcRenderer.invoke("dialog:confirm", options),
  dockerPrune: () => ipcRenderer.invoke("docker:prune"),
  getDiffFiles: payload => ipcRenderer.invoke("sessions:get-diff-files", payload),
  getFileDiff: payload => ipcRenderer.invoke("sessions:get-file-diff", payload),
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
