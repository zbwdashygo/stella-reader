/* 右侧滑出面板管理（设置 / 搜索）——同一时间只开一个 */

import { $ } from './util.js';

const openSet = new Set();
let initialized = false;

function backdrop() { return $('#panelBackdrop'); }

function syncBackdrop() {
  const el = backdrop();
  if (!el) return;
  if (openSet.size > 0) {
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('open'));
  } else {
    el.classList.remove('open');
    setTimeout(() => { if (openSet.size === 0) el.hidden = true; }, 260);
  }
  document.body.classList.toggle('panel-open', openSet.size > 0);
}

function init() {
  if (initialized) return;
  initialized = true;
  const el = backdrop();
  if (el) {
    el.addEventListener('click', () => closeAllPanels());
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && openSet.size > 0) {
      event.stopPropagation();
      closeAllPanels();
    }
  }, true);
}

export function registerPanel(panelEl, { onClose } = {}) {
  init();
  if (!panelEl) return;
  panelEl.__panelOnClose = onClose || null;
}

export function openPanel(panelEl) {
  if (!panelEl) return;
  init();
  Array.from(openSet).forEach((other) => {
    if (other !== panelEl) closePanel(other);
  });
  openSet.add(panelEl);
  panelEl.classList.add('open');
  panelEl.removeAttribute('aria-hidden');
  const btn = panelEl.__panelTrigger;
  if (btn) btn.setAttribute('aria-expanded', 'true');
  syncBackdrop();
}

export function closePanel(panelEl) {
  if (!panelEl || !openSet.has(panelEl)) return;
  openSet.delete(panelEl);
  panelEl.classList.remove('open');
  panelEl.setAttribute('aria-hidden', 'true');
  if (typeof panelEl.__panelOnClose === 'function') {
    try { panelEl.__panelOnClose(); } catch (err) { console.error(err); }
  }
  syncBackdrop();
}

export function togglePanel(panelEl) {
  if (!panelEl) return;
  if (openSet.has(panelEl)) closePanel(panelEl);
  else openPanel(panelEl);
}

export function closeAllPanels(except = null) {
  Array.from(openSet).forEach((panel) => {
    if (panel !== except) closePanel(panel);
  });
}

export function isPanelOpen(panelEl) {
  return openSet.has(panelEl);
}

export function anyPanelOpen() {
  return openSet.size > 0;
}
