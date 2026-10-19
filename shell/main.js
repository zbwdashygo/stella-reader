'use strict';
/**
 * Stella 星阅 —— Electron 主进程
 * 内嵌启动本地 HTTP 服务（server/index.js），窗口加载 http://127.0.0.1:<port>
 */
const { app, BrowserWindow, Menu, dialog, shell, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const APP_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(APP_ROOT, 'data');
const WINDOW_STATE_FILE = path.join(DATA_DIR, 'window-state.json');

// 便携化：Chromium 的 localStorage / 缓存也放进应用自己的 data 目录，
// 这样整个程序目录可整体拷贝，且「所有数据都在 data/」的说法成立。
try { app.setPath('userData', path.join(DATA_DIR, 'electron')); } catch (_) {}
try { app.setAppUserModelId('com.tingshu.epubplayer'); } catch (_) {}

let win = null;
let serverInfo = null;
let pendingEpub = findEpubArg(process.argv);

function findEpubArg(argv) {
  for (const a of argv) {
    if (typeof a === 'string' && /\.epub$/i.test(a) && fs.existsSync(a)) return a;
  }
  return null;
}

function readWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, 'utf8'));
    if (s && Number.isFinite(s.width) && Number.isFinite(s.height)) return s;
  } catch (_) {}
  return { width: 1280, height: 860, maximized: false };
}

function saveWindowState(w) {
  try {
    if (!w || w.isDestroyed() || w.isMinimized()) return;
    const b = w.getNormalBounds();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(WINDOW_STATE_FILE, JSON.stringify({
      width: b.width, height: b.height, x: b.x, y: b.y,
      maximized: w.isMaximized(),
    }), 'utf8');
  } catch (_) {}
}

/** 调用本地服务接口（导入用） */
function apiPost(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      timeout: 60000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        if (res.statusCode >= 400) return reject(new Error((json && json.error && json.error.message) || text || res.statusCode));
        resolve(json);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('本地服务超时')));
    req.end(data);
  });
}

async function handleEpubOpen(filePath) {
  if (!serverInfo || !win || win.isDestroyed()) { pendingEpub = filePath; return; }
  try {
    const result = await apiPost(serverInfo.port, '/api/books/import', { path: filePath });
    win.webContents.send('open-epub', { path: filePath, bookId: result && result.book && result.book.id });
  } catch (err) {
    dialog.showErrorBox('无法打开 EPUB', String(err && err.message || err));
  }
}

function createWindow() {
  const state = readWindowState();
  win = new BrowserWindow({
    width: state.width, height: state.height,
    minWidth: 640, minHeight: 620,
    x: state.x, y: state.y,
    show: false,
    title: 'Stella 星阅',
    backgroundColor: '#f7f3ea',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.on('app-command', (event, command) => { if(command === 'browser-backward' || command === 'browser-forward') { event.preventDefault(); win.webContents.send('stella-side-page', command === 'browser-forward' ? 1 : -1); } });
  Menu.setApplicationMenu(null);
  if (state.maximized) win.maximize();

  win.once('ready-to-show', () => { win.show(); });
  win.on('close', () => saveWindowState(win));
  win.on('closed', () => { win = null; });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${serverInfo ? serverInfo.port : ''}`)) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  const url = `http://127.0.0.1:${serverInfo.port}/`;
  win.loadURL(url).catch((err) => {
    dialog.showErrorBox('启动失败', `无法加载界面：${err && err.message}\n${url}`);
  });
}

ipcMain.handle('dialog:open-epub', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择 EPUB 文件',
    properties: ['openFile'],
    filters: [{ name: 'EPUB 电子书', extensions: ['epub'] }, { name: '所有文件', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePaths || !r.filePaths.length) return null;
  return { path: r.filePaths[0] };
});

ipcMain.handle('shell:open-external', async (_e, url) => {
  if (typeof url === 'string' && /^https?:/i.test(url)) await shell.openExternal(url);
  return true;
});

ipcMain.handle('win:toggle-fullscreen', () => {
  if (!win) return false;
  win.setFullScreen(!win.isFullScreen());
  return win.isFullScreen();
});

ipcMain.handle('app:info', () => ({ version: app.getVersion(), electron: process.versions.electron, port: serverInfo && serverInfo.port }));

async function boot() {
  // 内嵌启动后端服务
  const { start } = require('../server/index.js');
  serverInfo = await start({ port: Number(process.env.PORT) || 8787, dataDir: DATA_DIR });
  createWindow();
  if (pendingEpub) {
    const p = pendingEpub;
    pendingEpub = null;
    // 等页面就绪后再导入
    win.webContents.once('did-finish-load', () => setTimeout(() => handleEpubOpen(p), 400));
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    const p = findEpubArg(argv);
    if (p) handleEpubOpen(p);
  });

  app.whenReady().then(() => {
    boot().catch((err) => {
      dialog.showErrorBox('听书启动失败', String(err && err.stack || err));
      app.quit();
    });
  });

  app.on('window-all-closed', () => { app.quit(); });
  app.on('before-quit', () => { saveWindowState(win); });
}
