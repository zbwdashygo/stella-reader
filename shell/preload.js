'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('epubShell', {
  isElectron: true,
  platform: process.platform,
  openFileDialog: () => ipcRenderer.invoke('dialog:open-epub'),
  getFilePath: (file) => {
    try {
      if (file && typeof webUtils.getPathForFile === 'function') return webUtils.getPathForFile(file) || null;
    } catch (_) {}
    return null;
  },
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  toggleFullScreen: () => ipcRenderer.invoke('win:toggle-fullscreen'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  onOpenEpub: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (_e, payload) => { try { cb(payload); } catch (err) { console.error(err); } };
    ipcRenderer.on('open-epub', handler);
    return () => ipcRenderer.removeListener('open-epub', handler);
  },
});

ipcRenderer.on('stella-side-page', (_event, direction) => window.dispatchEvent(new CustomEvent('stella-side-page', { detail: direction })));
