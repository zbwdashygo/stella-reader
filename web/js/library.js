/* 书库：网格卡片、封面、进度、空状态、移除菜单 */

import { $, $$, clamp, escapeHtml, toast, confirmDialog } from './util.js';
import { icon } from './icons.js';
import { api } from './api.js';

const COVER_TONES = [
  ['#2f6f5e', '#1c473b', '#c9a227'],
  ['#37566b', '#22394a', '#d3b25c'],
  ['#6b4f3a', '#453024', '#d8b57a'],
  ['#4e5a3b', '#303c26', '#cdb36a'],
  ['#574766', '#362a44', '#d6b76b'],
  ['#7a4438', '#4c2a22', '#e0b76f'],
];

function hashString(text) {
  let hash = 0;
  const value = String(text || '');
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function createLibrary({ onOpenBook } = {}) {
  const els = {
    view: $('#libraryView'),
    grid: $('#bookGrid'),
    skeleton: $('#librarySkeleton'),
    empty: $('#emptyState'),
    error: $('#libraryError'),
    count: $('#libraryCount'),
    retry: $('#btnRetryLibrary'),
    refresh: $('#btnRefreshLibrary'),
    menu: $('#cardMenu'),
    menuOpenLabel: $('#cardMenuOpenLabel'),
  };

  let books = [];
  let loaded = false;
  let loading = false;
  let menuBookId = null;

  function coverFallback(book) {
    const tone = COVER_TONES[hashString(book.title || book.id) % COVER_TONES.length];
    return `<div class="cover-fallback" style="background:linear-gradient(158deg, ${tone[0]} 0%, ${tone[1]} 74%)">
      <div class="cover-fallback-top">${icon('headphones', 15)}</div>
      <div class="cover-fallback-main">
        <div class="cover-fallback-title">${escapeHtml(book.title || '未命名')}</div>
        <div class="cover-fallback-author">${escapeHtml(book.author || '未知作者')}</div>
      </div>
    </div>`;
  }

  function cardHtml(book, index) {
    const progress = book.progress || {};
    const percent = clamp(Math.round((Number(progress.percent) || 0) * 100), 0, 100);
    const started = percent > 0;
    const chapterTitle = progress.chapterTitle
      || (Number.isFinite(Number(progress.spineIndex)) ? `第 ${Number(progress.spineIndex) + 1} 章` : '');
    const progressText = started && chapterTitle
      ? `上次读到 ${escapeHtml(chapterTitle)} · ${percent}%`
      : `未开始 · 共 ${Number(book.spineCount) || 0} 章`;
    const cover = book.cover
      ? `<img class="book-cover-img" src="${escapeHtml(book.cover)}" alt="${escapeHtml(book.title)} 的封面" loading="lazy" data-cover>`
      : coverFallback(book);
    const cta = started ? '继续阅读' : '开始阅读';
    return `<article class="book-card" data-book-id="${escapeHtml(book.id)}" tabindex="0" role="button" aria-label="${escapeHtml(book.title || '未命名书籍')}" style="--i:${index}">
      <div class="book-cover">
        ${cover}
        <button class="card-menu-btn" data-menu="${escapeHtml(book.id)}" type="button" title="更多操作" aria-label="《${escapeHtml(book.title || '')}》更多操作">${icon('dots', 16)}</button>
        <span class="cover-cta">${icon('bookOpen', 14)}${cta}</span>
      </div>
      <h3 class="book-title">${escapeHtml(book.title || '未命名书籍')}</h3>
      <p class="book-author">${escapeHtml(book.author || '未知作者')}</p>
      <div class="book-progress-track"><div class="book-progress-fill" style="width:${percent}%"></div></div>
      <p class="book-progress-text ${started ? '' : 'is-new'}">${progressText}</p>
    </article>`;
  }

  function skeletonHtml(count = 8) {
    let html = '';
    for (let i = 0; i < count; i += 1) {
      html += `<div class="book-card skeleton-card" aria-hidden="true">
        <div class="book-cover"></div>
        <div class="skeleton-line"></div>
        <div class="skeleton-line short"></div>
        <div class="skeleton-line track"></div>
      </div>`;
    }
    return html;
  }

  function attachCoverFallbacks() {
    Array.from(els.grid.querySelectorAll('img[data-cover]')).forEach((img) => {
      img.addEventListener('error', () => {
        const card = img.closest('.book-card');
        const book = books.find((item) => item.id === (card && card.dataset.bookId));
        const wrap = img.closest('.book-cover');
        if (!wrap || !book) return;
        img.remove();
        wrap.insertAdjacentHTML('afterbegin', coverFallback(book));
      }, { once: true });
    });
  }

  function render() {
    if (!loaded) return;
    els.count.textContent = `${books.length} 本`;
    const isEmpty = books.length === 0;
    els.grid.hidden = isEmpty;
    els.empty.hidden = !isEmpty || !els.error.hidden;
    if (isEmpty) {
      els.grid.innerHTML = '';
      return;
    }
    els.grid.innerHTML = books.map(cardHtml).join('');
    attachCoverFallbacks();
  }

  async function load(options = {}) {
    const quiet = !!options.quiet;
    if (loading) return;
    loading = true;
    if (!quiet) {
      els.skeleton.innerHTML = skeletonHtml();
      els.skeleton.hidden = false;
      els.grid.hidden = true;
      els.empty.hidden = true;
      els.error.hidden = true;
    }
    try {
      const data = await api.listBooks();
      books = data && Array.isArray(data.books) ? data.books : [];
      loaded = true;
      els.error.hidden = true;
      els.skeleton.hidden = true;
      render();
    } catch (err) {
      if (!err || !err.isApiError) toast('读取书库失败，请稍后重试', 'error');
      els.skeleton.hidden = true;
      if (!loaded || !books.length) {
        els.grid.hidden = true;
        els.empty.hidden = true;
        els.error.hidden = false;
      }
    } finally {
      loading = false;
    }
  }

  function refresh(options = {}) { return load(options); }

  function closeCardMenu() {
    if (!els.menu) return;
    els.menu.hidden = true;
    menuBookId = null;
  }

  function openCardMenu(bookId, position = {}) {
    const book = books.find((item) => item.id === bookId);
    if (!book || !els.menu) return;
    menuBookId = bookId;
    els.menuOpenLabel.textContent = (book.progress && Number(book.progress.percent) > 0) ? '继续阅读' : '开始阅读';
    els.menu.hidden = false;
    const rect = els.menu.getBoundingClientRect();
    let x = Number(position.x) || 0;
    let y = Number(position.y) || 0;
    if (position.anchor) {
      const anchorRect = position.anchor.getBoundingClientRect();
      x = anchorRect.right - rect.width;
      y = anchorRect.bottom + 8;
    }
    const margin = 10;
    x = clamp(x, margin, Math.max(margin, window.innerWidth - rect.width - margin));
    y = clamp(y, margin, Math.max(margin, window.innerHeight - rect.height - margin));
    els.menu.style.left = `${x}px`;
    els.menu.style.top = `${y}px`;
  }

  function updateProgress(bookId, progress) {
    const book = books.find((item) => item.id === bookId);
    if (!book) return;
    book.progress = progress;
    book.lastReadAt = Date.now();
    if (els.view.hidden) return; // 阅读中不重复渲染
    const card = els.grid.querySelector(`.book-card[data-book-id="${bookId}"]`);
    if (!card) { render(); return; }
    const percent = clamp(Math.round((Number(progress.percent) || 0) * 100), 0, 100);
    const fill = card.querySelector('.book-progress-fill');
    if (fill) fill.style.width = `${percent}%`;
    const text = card.querySelector('.book-progress-text');
    if (text) {
      const chapterTitle = progress.chapterTitle || `第 ${Number(progress.spineIndex || 0) + 1} 章`;
      text.textContent = `上次读到 ${chapterTitle} · ${percent}%`;
      text.classList.remove('is-new');
    }
  }

  /* ---------------- 事件 ---------------- */

  els.grid.addEventListener('click', (event) => {
    const menuBtn = event.target && typeof event.target.closest === 'function'
      ? event.target.closest('[data-menu]') : null;
    if (menuBtn) {
      event.stopPropagation();
      openCardMenu(menuBtn.dataset.menu, { anchor: menuBtn });
      return;
    }
    const card = event.target && typeof event.target.closest === 'function'
      ? event.target.closest('.book-card') : null;
    if (!card) return;
    closeCardMenu();
    if (typeof onOpenBook === 'function') onOpenBook(card.dataset.bookId);
  });

  els.grid.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target && typeof event.target.closest === 'function'
      ? event.target.closest('.book-card') : null;
    if (!card) return;
    event.preventDefault();
    if (typeof onOpenBook === 'function') onOpenBook(card.dataset.bookId);
  });

  els.grid.addEventListener('contextmenu', (event) => {
    const card = event.target && typeof event.target.closest === 'function'
      ? event.target.closest('.book-card') : null;
    if (!card) return;
    event.preventDefault();
    openCardMenu(card.dataset.bookId, { x: event.clientX, y: event.clientY });
  });

  if (els.menu) {
    els.menu.addEventListener('click', async (event) => {
      const actionBtn = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-menu-action]') : null;
      const book = books.find((item) => item.id === menuBookId);
      if (!actionBtn || !book) return;
      closeCardMenu();
      if (actionBtn.dataset.menuAction === 'open') {
        if (typeof onOpenBook === 'function') onOpenBook(book.id);
        return;
      }
      if (actionBtn.dataset.menuAction === 'remove') {
        const confirmed = await confirmDialog({
          title: '从书库移除',
          message: `确定要从书库移除《${book.title || '这本书'}》吗？原始 EPUB 文件不会被删除。`,
          confirmText: '移除',
          danger: true,
          iconName: 'trash',
        });
        if (!confirmed) return;
        try {
          await api.deleteBook(book.id);
          toast(`已移除《${book.title || '书籍'}》`, 'success');
          await load({ quiet: true });
        } catch { /* api 已 toast */ }
      }
    });
  }

  document.addEventListener('click', (event) => {
    if (!els.menu || els.menu.hidden) return;
    if (els.menu.contains(event.target)) return;
    if (event.target && typeof event.target.closest === 'function' && event.target.closest('[data-menu]')) return;
    closeCardMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && els.menu && !els.menu.hidden) closeCardMenu();
  }, true);
  window.addEventListener('resize', closeCardMenu);
  els.view.addEventListener('scroll', closeCardMenu, { passive: true });

  els.retry.addEventListener('click', () => load());
  els.refresh.addEventListener('click', () => load());

  return {
    load,
    refresh,
    updateProgress,
    getBooks: () => books.slice(),
    isLoaded: () => loaded,
  };
}
