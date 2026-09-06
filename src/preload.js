'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tkb', {
  getState: () => ipcRenderer.invoke('state:get'),
  refresh: () => ipcRenderer.invoke('refresh'),
  login: () => ipcRenderer.invoke('login'),
  logout: () => ipcRenderer.invoke('logout'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  getChanges: () => ipcRenderer.invoke('changes:get'),
  markChangesRead: () => ipcRenderer.invoke('changes:read'),
  clearChanges: () => ipcRenderer.invoke('changes:clear'),
  testNotify: () => ipcRenderer.invoke('notify:test'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onState: (cb) => { ipcRenderer.on('state', (_e, s) => cb(s)); },
  onShowChanges: (cb) => { ipcRenderer.on('show-changes', () => cb()); },
});
