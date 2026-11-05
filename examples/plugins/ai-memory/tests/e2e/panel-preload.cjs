const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pluginBridge', {
  invoke: (channel, payload) => ipcRenderer.invoke('ai-memory-panel-fixture', channel, payload),
  on: () => {},
});
