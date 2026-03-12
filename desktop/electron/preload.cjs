const { contextBridge, ipcRenderer } = require("electron");

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
