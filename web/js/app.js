import {setupVoiceSettings} from './voice-settings.js';
import {setupStella} from './stella.js';
/* 应用入口：视图切换、设置面板、导入/拖拽、全局快捷键 */

import { $, toast, fileToBase64, isEpubFile, escapeHtml } from './util.js';
import { api } from './api.js';
import { initSettings, getSettings, updateSettings, resetSettings, subscribe } from './settings.js';
import { registerPanel, openPanel, closePanel, closeAllPanels } from './panels.js';
import { createLibrary } from './library.js';
import { createReader } from './reader.js';
import { createTtsController, bindTtsUi } from './tts.js';

const els = {
  libraryView: $('#libraryView'),
  readerView: $('#readerView'),
  fileInput: $('#fileInput'),
  dropOverlay: $('#dropOverlay'),
  settingsPanel: $('#settingsPanel'),
  btnLibrarySettings: $('#btnLibrarySettings'),
  btnSettings: $('#btnSettings'),
  btnCloseSettings: $('#btnCloseSettings'),
  btnFullscreen: $('#btnFullscreen'),
  themeOptions: $('#themeOptions'),
  settingFont: $('#settingFont'),
  settingFontSize: $('#settingFontSize'),
  settingFontSizeValue: $('#settingFontSizeValue'),
  settingLineHeight: $('#settingLineHeight'),
  settingLineHeightValue: $('#settingLineHeightValue'),
  settingPageWidth: $('#settingPageWidth'),
  settingPageWidthValue: $('#settingPageWidthValue'),
  settingSpacing: $('#settingSpacing'),
  settingSpacingValue: $('#settingSpacingValue'),
  settingTtsVoice: $('#settingTtsVoice'),
  settingTtsRate: $('#settingTtsRate'),
  settingTtsRateValue: $('#settingTtsRateValue'),
  settingTtsAutoNext: $('#settingTtsAutoNext'),
  settingTtsHighlight: $('#settingTtsHighlight'),
  btnResetSettings: $('#btnResetSettings'),
};

let reader = null;
let library = null;

/* ------------------------------------------------------------------ */
/* 听觉（TTS）与阅读器                                                  */
/* ------------------------------------------------------------------ */

const tts = createTtsController({
  onChapterEnd: () => (reader ? reader.loadNextChapterForTts() : Promise.resolve(false)),
});
bindTtsUi(tts);

reader = createReader({
  tts,
  onExit: () => showLibrary(),
  onBookProgress: (bookId, progress) => { if (library) library.updateProgress(bookId, progress); },
});

library = createLibrary({
  onOpenBook: (bookId) => { reader.open(bookId); },
});

reader.setKeyHandler(onGlobalKeyDown);

/* ------------------------------------------------------------------ */
/* 视图                                                                */
/* ------------------------------------------------------------------ */

function showLibrary() {
  els.libraryView.hidden = false;
  els.readerView.hidden = true;
  document.body.classList.remove('is-reading');
  document.title = 'Stella 星阅';
  if (library) library.refresh({ quiet: true });
}

/* ------------------------------------------------------------------ */
/* 设置面板                                                             */
/* ------------------------------------------------------------------ */

function formatRate(value) {
  return `${Number(value).toFixed(2).replace(/0$/, '')}×`;
}

function syncSettingsControls() {
  const settings = getSettings();
  Array.from(els.themeOptions.querySelectorAll('[data-theme-choice]')).forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.themeChoice === settings.theme);
  });
  els.settingFont.value = settings.font;
  els.settingFontSize.value = String(settings.fontSize);
  els.settingFontSizeValue.textContent = `${settings.fontSize}px`;
  els.settingLineHeight.value = String(settings.lineHeight);
  els.settingLineHeightValue.textContent = Number(settings.lineHeight).toFixed(2);
  els.settingPageWidth.value = String(settings.pageWidth);
  els.settingPageWidthValue.textContent = `${settings.pageWidth}px`;
  els.settingSpacing.value = String(settings.paragraphSpacing);
  els.settingSpacingValue.textContent = `${Number(settings.paragraphSpacing).toFixed(1)}em`;
  els.settingTtsRate.value = String(settings.ttsRate);
  els.settingTtsRateValue.textContent = formatRate(settings.ttsRate);
  els.settingTtsAutoNext.checked = !!settings.ttsAutoNext;
  els.settingTtsHighlight.checked = !!settings.ttsHighlight;
  const hasVoice = Array.from(els.settingTtsVoice.options).some((opt) => opt.value === settings.ttsVoice);
  els.settingTtsVoice.value = hasVoice ? settings.ttsVoice : '';
}

function voiceOptionHtml(voice) {
  return `<option value="${escapeHtml(voice.voiceURI)}">${escapeHtml(voice.name)}${voice.lang ? ` · ${escapeHtml(voice.lang)}` : ''}</option>`;
}

function populateVoiceSelect(voices) {
  const zh = voices.filter((voice) => tts.isZhVoice(voice));
  const others = voices.filter((voice) => !tts.isZhVoice(voice));
  const parts = ['<option value="">自动（中文优先）</option>'];
  if (zh.length) {
    parts.push('<optgroup label="中文语音">');
    zh.forEach((voice) => parts.push(voiceOptionHtml(voice)));
    parts.push('</optgroup>');
  }
  if (others.length) {
    parts.push('<optgroup label="其他语音">');
    others.forEach((voice) => parts.push(voiceOptionHtml(voice)));
    parts.push('</optgroup>');
  }
  if (!voices.length) {
    parts.push('<option value="" disabled>未检测到浏览器语音，将使用系统语音</option>');
  }
  els.settingTtsVoice.innerHTML = parts.join('');
  syncSettingsControls();
}

function setupSettingsPanel() {
  registerPanel(els.settingsPanel);
  const openSettings = () => {
    syncSettingsControls();
    openPanel(els.settingsPanel);
  };
  els.btnLibrarySettings.addEventListener('click', openSettings);
  els.btnSettings.addEventListener('click', openSettings);
  els.btnCloseSettings.addEventListener('click', () => closePanel(els.settingsPanel));

  els.themeOptions.addEventListener('click', (event) => {
    const btn = event.target && typeof event.target.closest === 'function'
      ? event.target.closest('[data-theme-choice]') : null;
    if (!btn) return;
    updateSettings({ theme: btn.dataset.themeChoice });
  });

  els.settingFont.addEventListener('change', () => updateSettings({ font: els.settingFont.value }));

  els.settingFontSize.addEventListener('input', () => {
    els.settingFontSizeValue.textContent = `${els.settingFontSize.value}px`;
    updateSettings({ fontSize: Number(els.settingFontSize.value) });
  });
  els.settingLineHeight.addEventListener('input', () => {
    els.settingLineHeightValue.textContent = Number(els.settingLineHeight.value).toFixed(2);
    updateSettings({ lineHeight: Number(els.settingLineHeight.value) });
  });
  els.settingPageWidth.addEventListener('input', () => {
    els.settingPageWidthValue.textContent = `${els.settingPageWidth.value}px`;
    updateSettings({ pageWidth: Number(els.settingPageWidth.value) });
  });
  els.settingSpacing.addEventListener('input', () => {
    els.settingSpacingValue.textContent = `${Number(els.settingSpacing.value).toFixed(1)}em`;
    updateSettings({ paragraphSpacing: Number(els.settingSpacing.value) });
  });

  els.settingTtsRate.addEventListener('input', () => {
    els.settingTtsRateValue.textContent = formatRate(els.settingTtsRate.value);
    updateSettings({ ttsRate: Number(els.settingTtsRate.value) });
  });
  els.settingTtsRate.addEventListener('change', () => tts.refreshCurrent());
  els.settingTtsVoice.addEventListener('change', () => {
    updateSettings({ ttsVoice: els.settingTtsVoice.value });
    tts.refreshCurrent();
  });
  els.settingTtsAutoNext.addEventListener('change', () => updateSettings({ ttsAutoNext: els.settingTtsAutoNext.checked }));
  els.settingTtsHighlight.addEventListener('change', () => updateSettings({ ttsHighlight: els.settingTtsHighlight.checked }));

  els.btnResetSettings.addEventListener('click', () => {
    resetSettings();
    toast('已恢复默认设置', 'success');
  });

  subscribe(() => syncSettingsControls());
  tts.onVoicesChanged((voices) => populateVoiceSelect(voices));
  populateVoiceSelect(tts.getVoices());
  syncSettingsControls();
}

/* ------------------------------------------------------------------ */
/* 导入                                                                */
/* ------------------------------------------------------------------ */

let importing = false;

function setImporting(value) {
  importing = value;
  Array.from(document.querySelectorAll('[data-import]')).forEach((btn) => {
    btn.disabled = value;
    btn.classList.toggle('is-loading', value);
  });
}

function normalizeDialogResult(result) {
  if (!result) return [];
  if (typeof result === 'string') return result ? [result] : [];
  if (Array.isArray(result)) {
    return result
      .map((item) => (typeof item === 'string' ? item : item && item.path))
      .filter(Boolean);
  }
  if (typeof result === 'object' && result.path) return [result.path];
  return [];
}

async function importEpub() {
  if (importing) return;
  if(window.AndroidBridge){window.AndroidBridge.pickBook();return;}
  const shell = window.epubShell;
  if (shell && typeof shell.openFileDialog === 'function') {
    let result;
    try {
      result = await shell.openFileDialog();
    } catch (err) {
      toast('无法打开文件选择器', 'error');
      return;
    }
    const paths = normalizeDialogResult(result);
    if (!paths.length) return;
    await importPaths(paths);
    return;
  }
  els.fileInput.value = '';
  els.fileInput.click();
}

async function importPaths(paths) {
  if (!paths.length) return;
  setImporting(true);
  try {
    for (const path of paths) {
      try {
        const data = await api.importByPath(path);
        const title = data && data.book ? data.book.title : '';
        toast(`已导入《${title || '书籍'}》`, 'success');
      } catch { /* api 已 toast */ }
    }
  } finally {
    setImporting(false);
    if (library) library.refresh({ quiet: true });
  }
}

async function importFiles(files) {
  const list = Array.from(files || []);
  if (!list.length) return;
  const valid = list.filter(isEpubFile);
  if (!valid.length) {
    toast('只能导入 .epub 格式的文件', 'error');
    return;
  }
  if (valid.length < list.length) toast('已忽略非 EPUB 文件', 'info');
  const shell = window.epubShell;
  const byPath = [];
  const byBytes = [];
  for (const file of valid) {
    let path = null;
    try {
      if (shell && typeof shell.getFilePath === 'function') path = shell.getFilePath(file);
    } catch { path = null; }
    if (!path && file.path) path = file.path;
    if (path) byPath.push(path);
    else byBytes.push(file);
  }

  if (byPath.length) await importPaths(byPath);
  if (!byBytes.length) return;

  setImporting(true);
  try {
    for (const file of byBytes) {
      try {
        const dataBase64 = await fileToBase64(file);
        const data = await api.importByBytes(file.name, dataBase64);
        const title = data && data.book ? data.book.title : file.name;
        toast(`已导入《${title}》`, 'success');
      } catch { /* api 已 toast */ }
    }
  } finally {
    setImporting(false);
    if (library) library.refresh({ quiet: true });
  }
}

function setupImport() {
  Array.from(document.querySelectorAll('[data-import]')).forEach((btn) => {
    btn.addEventListener('click', importEpub);
  });
  els.fileInput.addEventListener('change', () => {
    const files = Array.from(els.fileInput.files || []);
    els.fileInput.value = '';
    if (files.length) importFiles(files);
  });
}

/* ------------------------------------------------------------------ */
/* 拖拽导入                                                             */
/* ------------------------------------------------------------------ */

function hasFiles(event) {
  const transfer = event.dataTransfer;
  if (!transfer) return false;
  const types = transfer.types;
  if (!types) return false;
  try { return Array.from(types).includes('Files'); }
  catch { return false; }
}

function setupDragAndDrop() {
  let depth = 0;
  const hide = () => { depth = 0; els.dropOverlay.hidden = true; };
  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth += 1;
    els.dropOverlay.hidden = false;
  });
  window.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    try { event.dataTransfer.dropEffect = 'copy'; } catch { /* ignore */ }
    els.dropOverlay.hidden = false;
  });
  window.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) els.dropOverlay.hidden = true;
  });
  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []);
    hide();
    if (files.length) importFiles(files);
  });
  window.addEventListener('dragend', hide);
  window.addEventListener('blur', hide);
}

/* ------------------------------------------------------------------ */
/* 全屏                                                                */
/* ------------------------------------------------------------------ */

function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) {
      const request = document.documentElement.requestFullscreen;
      if (typeof request === 'function') {
        const promise = request.call(document.documentElement);
        if (promise && typeof promise.catch === 'function') {
          promise.catch(() => toast('当前环境不支持全屏', 'error'));
        }
      } else {
        toast('当前环境不支持全屏', 'error');
      }
    } else if (typeof document.exitFullscreen === 'function') {
      document.exitFullscreen();
    }
  } catch {
    toast('当前环境不支持全屏', 'error');
  }
}

function setupReaderControls() {
  els.btnFullscreen.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => {
    els.btnFullscreen.title = document.fullscreenElement ? '退出全屏（f）' : '全屏（f）';
  });
}

/* ------------------------------------------------------------------ */
/* 桌面壳桥接：双击 .epub / 第二实例传参打开                             */
/* ------------------------------------------------------------------ */

async function handleShellOpenEpub(payload) {
  const bookId = payload && payload.bookId;
  const filePath = payload && payload.path;
  // 壳在通知前已完成导入；这里刷新书库以拿到最新数据
  try {
    if (library) await library.refresh({ quiet: true });
  } catch (err) {
    console.error('[听书] 刷新书库失败', err);
  }
  if (bookId) {
    // 无论当前在书库还是阅读器，都直接切到目标书并恢复进度
    try { reader.open(bookId); } catch (err) { console.error('[听书] 打开书籍失败', err); }
    return;
  }
  if (filePath) toast('已导入，请点击书封开始阅读', 'info');
}

function setupShellBridge() {
  const shell = window.epubShell;
  if (!shell || typeof shell.onOpenEpub !== 'function') return;
  try {
    shell.onOpenEpub((payload) => { handleShellOpenEpub(payload); });
  } catch (err) {
    console.error('[听书] 注册 open-epub 监听失败', err);
  }
}

/* ------------------------------------------------------------------ */
/* 全局快捷键                                                           */
/* ------------------------------------------------------------------ */

function onGlobalKeyDown(event) {
  const target = event.target;
  const tag = target && target.tagName ? String(target.tagName).toUpperCase() : '';
  const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    || !!(target && target.isContentEditable);

  if (event.key === 'Escape') {
    if (reader.isOpen() && reader.closeOverlays()) {
      event.preventDefault();
    }
    return;
  }

  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    const key = String(event.key || '').toLowerCase();
    if (key === 'o') {
      event.preventDefault();
      importEpub();
      return;
    }
    if (key === 'f') {
      if (reader.isOpen()) {
        event.preventDefault();
        reader.openSearch();
        return;
      }
      return;
    }
  }

  if (isTyping) return;
  if (!reader.isOpen()) return;

  const key = event.key;
  if (key === 'ArrowLeft') {
    event.preventDefault();
    reader.prevChapter();
    return;
  }
  if (key === 'ArrowRight') {
    event.preventDefault();
    reader.nextChapter();
    return;
  }
  if (key === ' ' || key === 'PageDown' || key === 'ArrowDown') {
    if (tag === 'BUTTON' && key === ' ') return;
    event.preventDefault();
    reader.scrollByPages(event.shiftKey ? -1 : 1);
    return;
  }
  if (key === 'PageUp' || key === 'ArrowUp') {
    event.preventDefault();
    reader.scrollByPages(-1);
    return;
  }
  if (key === 't' || key === 'T') {
    event.preventDefault();
    tts.toggle();
    return;
  }
  if (key === 'f' || key === 'F') {
    event.preventDefault();
    toggleFullscreen();
  }
}

function setupGlobalShortcuts() {
  document.addEventListener('keydown', onGlobalKeyDown);
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                             */
/* ------------------------------------------------------------------ */

function setupLifecycle() {
  const flush = () => {
    if (reader && reader.isOpen()) reader.flushProgress();
  };
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('online', () => toast('网络已恢复', 'info', 1800));
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

function init() {
  initSettings();
  setupSettingsPanel();
  setupImport();
  setupDragAndDrop();
  setupGlobalShortcuts();
  setupReaderControls();
  setupShellBridge();
  setupLifecycle();
  library.load();
  setupStella({reader,library,tts});
  setupVoiceSettings();
  const splash=document.getElementById('stellaSplash');
  setTimeout(()=>splash?.classList.add('finished'),850);
  setTimeout(()=>splash?.remove(),1500);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}

// 便于桌面壳/调试检查
window.addEventListener('error', (event) => {
  const message = event && event.message ? event.message : '未知脚本错误';
  console.error('[听书] 未捕获错误：', event.error || message);
});
