/* 听书 · EPUB 播放器 —— 通用工具 */

export const $ = (sel, root = document) => (root || document).querySelector(sel);
export const $$ = (sel, root = document) => Array.from((root || document).querySelectorAll(sel));

export function clamp(value, min, max) {
  const n = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
}

export function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

export function debounce(fn, wait = 200) {
  let timer = null;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, wait);
  };
  wrapped.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  wrapped.pending = () => timer !== null;
  return wrapped;
}

export function throttle(fn, wait = 100) {
  let last = 0;
  let timer = null;
  const wrapped = (...args) => {
    const now = Date.now();
    const remain = wait - (now - last);
    if (remain <= 0) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => { timer = null; last = Date.now(); fn(...args); }, remain);
    }
  };
  wrapped.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  return wrapped;
}

export function prefersDark() {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
  catch { return false; }
}

export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch { return false; }
  },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

/* ------------------------------------------------------------------ */
/* Toast                                                               */
/* ------------------------------------------------------------------ */

const TOAST_ICON = {
  error: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16.5h.01"/></svg>',
  success: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  info: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.5h.01"/></svg>',
};

export function toast(message, type = 'info', duration = 3600) {
  const wrap = $('#toastWrap');
  if (!wrap) return;
  const text = String(message == null ? '' : message).trim();
  if (!text) return;
  while (wrap.children.length >= 4) wrap.removeChild(wrap.firstElementChild);
  const item = document.createElement('div');
  item.className = `toast toast-${type}`;
  item.setAttribute('role', type === 'error' ? 'alert' : 'status');
  item.innerHTML = `<span class="toast-icon">${TOAST_ICON[type] || TOAST_ICON.info}</span><span class="toast-text"></span>`;
  item.querySelector('.toast-text').textContent = text;
  wrap.appendChild(item);
  requestAnimationFrame(() => item.classList.add('show'));
  const dismiss = () => {
    item.classList.remove('show');
    setTimeout(() => item.remove(), 320);
  };
  const timer = setTimeout(dismiss, duration);
  item.addEventListener('click', () => { clearTimeout(timer); dismiss(); });
}

/* ------------------------------------------------------------------ */
/* 自定义确认框                                                        */
/* ------------------------------------------------------------------ */

let confirmCleanup = null;

export function confirmDialog(options = {}) {
  const modal = $('#confirmModal');
  if (!modal) return Promise.resolve(window.confirm(options.message || '确定继续吗？'));

  const {
    title = '请确认', message = '', confirmText = '确定', cancelText = '取消',
    danger = true, iconName = 'alert',
  } = options;

  if (confirmCleanup) confirmCleanup(false);

  const titleEl = $('#confirmTitle');
  const msgEl = $('#confirmMessage');
  const okBtn = $('#confirmOk');
  const cancelBtn = $('#confirmCancel');
  const iconEl = $('#confirmIcon');

  if (titleEl) titleEl.textContent = title;
  if (msgEl) msgEl.textContent = message;
  if (okBtn) {
    okBtn.textContent = confirmText;
    okBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  }
  if (cancelBtn) cancelBtn.textContent = cancelText;
  if (iconEl) {
    iconEl.className = `modal-icon ${danger ? 'is-danger' : 'is-primary'}`;
    iconEl.innerHTML = iconName === 'trash'
      ? '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>'
      : '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16.5h.01"/></svg>';
  }

  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add('open'));
  setTimeout(() => okBtn && okBtn.focus(), 60);

  return new Promise((resolve) => {
    const finish = (result) => {
      if (confirmCleanup !== finish) return;
      confirmCleanup = null;
      modal.classList.remove('open');
      setTimeout(() => { modal.hidden = true; }, 200);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onBackdrop = (e) => { if (e.target === modal) finish(false); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      else if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    };
    confirmCleanup = finish;
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey, true);
    if (okBtn) okBtn.onclick = () => finish(true);
    if (cancelBtn) cancelBtn.onclick = () => finish(false);
  });
}

/* ------------------------------------------------------------------ */
/* 其他                                                                */
/* ------------------------------------------------------------------ */

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function isEpubFile(file) {
  if (!file) return false;
  return /\.epub$/i.test(file.name || '') || file.type === 'application/epub+zip';
}

export function openExternal(url) {
  if (!url) return;
  try {
    if (window.epubShell && typeof window.epubShell.openExternal === 'function') {
      window.epubShell.openExternal(url);
      return;
    }
  } catch { /* 壳调用失败时继续用 window.open */ }
  try { window.open(url, '_blank', 'noopener,noreferrer'); }
  catch { toast('无法打开外部链接', 'error'); }
}
