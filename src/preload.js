const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  loginMicrosoft: () => ipcRenderer.invoke('account:login'),
  createLocalAccount: (name) => ipcRenderer.invoke('account:create-local', name),
  launchGame: (settings) => ipcRenderer.invoke('game:launch', settings),
  checkJava: () => ipcRenderer.invoke('java:check'),
  removeAccount: (id) => ipcRenderer.invoke('account:remove', id),
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('launcher:status', listener);
    return () => ipcRenderer.removeListener('launcher:status', listener);
  }
});
