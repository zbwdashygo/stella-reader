/* 阅读器：iframe 章节渲染、目录抽屉、搜索、进度、主题注入、TTS 协同 */

import { $, clamp, debounce, escapeHtml, toast, openExternal } from './util.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { getSettings, getReaderPalette, fontStack, resolvedTheme, subscribe, updateSettings } from './settings.js';
import { registerPanel, openPanel, closePanel, closeAllPanels } from './panels.js';

const XHTML_NS = 'http://www.w3.org/1999/xhtml';

function safeDecode(value) {
  try { return decodeURIComponent(String(value || '')); }
  catch { return String(value || ''); }
}

function createDocElement(doc, tag) {
  try {
    if (doc.contentType === 'application/xhtml+xml') return doc.createElementNS(XHTML_NS, tag);
  } catch { /* ignore */ }
  return doc.createElement(tag);
}

function escapeSelector(value) {
  const text = String(value || '');
  try {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(text);
  } catch { /* ignore */ }
  return text.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

export function createReader({ tts, onExit, onBookProgress } = {}) {
  const els = {
    view: $('#readerView'),
    toolbar: $('#readerToolbar'),
    title: $('#tbTitle'),
    author: $('#tbAuthor'),
    frame: $('#chapterFrame'),
    pageCounter: $('#mobilePageCounter'),
    pageDetails: $('#mobilePageDetails'),
    prevPage: $('#btnPrevPage'),
    nextPage: $('#btnNextPage'),
    readingMode: $('#btnReadingMode'),
    settingReadingMode: $('#settingReadingMode'),
    veil: $('#frameVeil'),
    tocDrawer: $('#tocDrawer'),
    tocList: $('#tocList'),
    tocCount: $('#tocCount'),
    tocEmpty: $('#tocEmpty'),
    tocBtn: $('#btnToc'),
    btnCloseToc: $('#btnCloseToc'),
    chapterIndicator: $('#chapterIndicator'),
    percent: $('#progressPercent'),
    progress: $('#bookProgress'),
    prevBtn: $('#btnPrevChapter'),
    nextBtn: $('#btnNextChapter'),
    searchPanel: $('#searchPanel'),
    searchInput: $('#searchInput'),
    searchResults: $('#searchResults'),
    searchIdle: $('#searchIdle'),
    searchLoading: $('#searchLoading'),
    searchEmpty: $('#searchEmpty'),
    searchSummary: $('#searchSummary'),
    btnClearSearch: $('#btnClearSearch'),
    btnCloseSearch: $('#btnCloseSearch'),
    btnSearch: $('#btnSearch'),
    btnBackLibrary: $('#btnBackLibrary'),
  };

  const state = {
    open: false,
    book: null,
    spine: [],
    toc: [],
    tocItems: [],
    index: 0,
    doc: null,
    win: null,
    loadSeq: 0,
    dragging: false,
    dragTarget: null,
    searchToken: 0,
    searchQuery: '',
    restoring: false,
    dirty: false,
    pendingScroll: { scrollRatio: 0, anchor: null, highlightTerm: null },
    pendingTtsDriven: false,
    lastUserScroll: 0,
  };

  const mobileLayout = () => window.matchMedia('(max-width: 700px)').matches;
  const pagingMode = () => getSettings().readingMode === 'paged';
  let pageTransition = false;
  let frameKeyHandler = null;
  let pageLayoutObserver = null;
  let turnBusyUntil = 0;
  let lastProgressErrorToast = 0;
  let toolbarTimer = null;
  const HEADLESS = !!(navigator && navigator.webdriver);

  /* ------------------------------------------------------------------ */
  /* 打开 / 关闭                                                         */
  /* ------------------------------------------------------------------ */

  async function open(bookId) {
    if (state.open && state.book && state.doc) await saveProgressNow();
    state.open = true;
    state.book = null;
    state.spine = [];
    state.toc = [];
    state.doc = null;
    state.win = null;
    state.loadSeq += 1;
    closeAllPanels();
    setTocOpen(false);
    if (tts) { tts.stop({ silent: true }); tts.closePanel(); }
    els.view.hidden = false;
    document.body.classList.add('is-reading');
    document.title = 'Stella 星阅';
    els.title.textContent = '正在载入…';
    els.author.textContent = '';
    showVeil(true);
    revealToolbar(true);
    resetSearch();

    try {
      const data = await api.getBook(bookId);
      if (!data || !data.book) throw new Error('书籍数据无效');
      state.book = data.book;
      state.spine = Array.isArray(data.spine) ? data.spine : [];
      state.toc = Array.isArray(data.toc) ? data.toc : [];
      if (!state.spine.length) throw new Error('这本书没有可读章节');
      els.title.textContent = state.book.title || '未命名书籍';
      els.author.textContent = state.book.author || '未知作者';
      document.title = `${state.book.title || '阅读'} · Stella 星阅`;
      const progress = state.book.progress || {};
      const index = clamp(progress.spineIndex == null ? 0 : progress.spineIndex, 0, state.spine.length - 1);
      const ratio = clamp(progress.scrollRatio == null ? 0 : progress.scrollRatio, 0, 1);
      renderToc();
      updateChapterChrome();
      const ok = await loadChapter(index, { scrollRatio: ratio, locator: progress.locator, initial:true });
      if (!ok) throw new Error('章节载入失败');
      revealToolbar(true);
    } catch (err) {
      if (!err || !err.isApiError) toast(`打开书籍失败：${err && err.message ? err.message : err}`, 'error');
      state.open = false;
      els.view.hidden = true;
      document.body.classList.remove('is-reading');
      if (typeof onExit === 'function') onExit();
    }
  }

  function close() {
    flushProgress();
    if (tts) { tts.stop({ silent: true }); tts.closePanel(); }
    closeAllPanels();
    setTocOpen(false);
    pageLayoutObserver?.disconnect();
    state.loadSeq += 1;
    state.open = false;
    state.book = null;
    state.spine = [];
    state.toc = [];
    state.tocItems = [];
    state.doc = null;
    state.win = null;
    els.view.hidden = true;
    els.view.classList.remove('toolbar-hidden');
    document.body.classList.remove('is-reading');
    document.title = 'Stella 星阅';
    try { els.frame.src = 'about:blank'; } catch { /* ignore */ }
    els.tocList.innerHTML = '';
    els.tocCount.textContent = '';
    resetSearch();
    clearTimeout(toolbarTimer);
    if (typeof onExit === 'function') onExit();
  }

  function resetSearch() {
    state.searchToken += 1;
    state.searchQuery = '';
    if (els.searchInput) els.searchInput.value = '';
    if (els.btnClearSearch) els.btnClearSearch.hidden = true;
    if (els.searchResults) els.searchResults.innerHTML = '';
    if (els.searchSummary) els.searchSummary.textContent = '';
    setSearchState('idle');
  }

  /* ------------------------------------------------------------------ */
  /* 章节加载                                                             */
  /* ------------------------------------------------------------------ */

  async function loadChapter(index, options = {}) {
    if (!state.book || !state.spine.length) return false;
    const target = clamp(index, 0, state.spine.length - 1);
    const seq = ++state.loadSeq;
    const wasActive = !!(tts && tts.isActive());
    if (!options.ttsDriven && tts) tts.stop({ silent: true });
    setTocOpen(false);
    state.restoring = true;
    state.dirty = !options.initial;
    state.index = target;
    state.doc = null;
    state.win = null;
    state.pendingScroll = {
      scrollRatio: clamp(options.scrollRatio == null ? 0 : options.scrollRatio, 0, 1),
      anchor: options.anchor || null,
      locator: options.locator || null,
      highlightTerm: options.highlightTerm || null,
    };
    state.pendingTtsDriven = !!options.ttsDriven;
    showVeil(true);
    updateChapterChrome();
    renderTocActive();
    revealToolbar(false);

    const chapter = state.spine[target];
    const path = chapter && chapter.path;
    if (!path) { showVeil(false); toast('章节路径缺失，无法加载', 'error'); return false; }
    const url = api.resUrl(state.book.id, path);
    const loadPromise = waitForFrameLoad(seq, url);
    try {
      els.frame.src = url;
      await loadPromise;
    } catch (err) {
      if (seq === state.loadSeq) {
        showVeil(false);
        toast(err && err.message ? err.message : '章节载入失败', 'error');
        if (tts) tts.stop({ silent: true });
      }
      return false;
    }
    if (seq !== state.loadSeq) return false;

    try {
      state.doc = els.frame.contentDocument;
      state.win = els.frame.contentWindow;
      if (!state.doc || !state.doc.documentElement) throw new Error('无法读取章节内容');
      injectStyles();
      bindFrameEvents();
      restorePosition();
      if (state.pendingScroll.highlightTerm) {
        setTimeout(() => highlightTermInDoc(state.pendingScroll.highlightTerm), 60);
      }
      hideVeilSoon();
      updateProgressUi();
      setTimeout(() => { if(seq === state.loadSeq) { state.restoring = false; if(state.dirty) saveProgressNow(); } }, 400);
      if (tts) {
        const meta = getChapterMeta();
        if (state.pendingTtsDriven) tts.setChapter(state.doc, meta, { autoplay: false });
        else tts.setChapter(state.doc, meta, { autoplay: wasActive });
      }
      return true;
    } catch (err) {
      console.error('[reader render]', err);
      showVeil(false);
      toast(`章节渲染失败：${err && err.message ? err.message : err}`, 'error');
      return false;
    }
  }

  function waitForFrameLoad(seq, url) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const expected = safeDecode(url);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('章节加载超时，请确认本地听书服务正在运行'));
      }, 20000);
      function cleanup() {
        clearTimeout(timer);
        els.frame.removeEventListener('load', onLoad);
      }
      function onLoad() {
        if (settled) return;
        if (seq !== state.loadSeq) { settled = true; cleanup(); resolve(); return; }
        let href = '';
        try { href = safeDecode(String((els.frame.contentWindow && els.frame.contentWindow.location.href) || '')); }
        catch { href = ''; }
        // 过滤掉旧导航产生的 load 事件
        if (expected && href && !href.includes(expected)) return;
        settled = true;
        cleanup();
        resolve();
      }
      els.frame.addEventListener('load', onLoad);
    });
  }

  function showVeil(show) {
    if (!els.veil) return;
    els.veil.classList.toggle('is-hidden', !show);
  }

  function hideVeilSoon() {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => showVeil(false));
    });
    setTimeout(() => showVeil(false), 500);
  }

  /* ------------------------------------------------------------------ */
  /* iframe 样式注入                                                      */
  /* ------------------------------------------------------------------ */

  function buildChapterCss() {
    const settings = getSettings();
    const palette = getReaderPalette();
    const font = fontStack(settings.font);
    const spacing = clamp(settings.paragraphSpacing, 0, 1.5);
    const dark = resolvedTheme() === 'night';
    return `
:root { color-scheme: ${dark ? 'dark' : 'light'}; }
html { background: ${palette.bg} !important; overscroll-behavior-x: none; touch-action: ${mobileLayout() && pagingMode()?'pinch-zoom':'pan-y pinch-zoom'}; }
body { overscroll-behavior-x: none; touch-action: ${mobileLayout() && pagingMode()?'pan-x pinch-zoom':'pan-y pinch-zoom'}; }
body {
  background: ${palette.bg} !important;
  color: ${palette.text} !important;
  max-width: ${settings.pageWidth}px !important;
  margin: 0 auto !important;
  padding: 48px 24px 96px !important;
  font-family: ${font} !important;
  font-size: ${settings.fontSize}px !important;
  line-height: ${settings.lineHeight} !important;
  box-sizing: border-box;
  overflow-wrap: break-word;
  word-break: normal;
  text-rendering: optimizeLegibility;
}
body * { box-sizing: border-box; }
p, li, dd, blockquote { text-align: justify; text-justify: inter-ideograph; }
p { margin-top: ${spacing}em !important; margin-bottom: ${spacing}em !important; }
h1, h2, h3, h4, h5, h6 { color: ${palette.text}; line-height: 1.35; font-family: ${font}; }
a, a:visited { color: ${palette.link}; }
img, svg, video, canvas, object { max-width: 100% !important; height: auto !important; }
img { border-radius: 4px; }
pre { overflow-x: auto; max-width: 100%; padding: 12px 14px; background: ${palette.codeBg}; border-radius: 8px; }
code, kbd, samp, pre { font-family: ui-monospace, "Cascadia Code", Consolas, "Courier New", monospace; }
table { max-width: 100% !important; border-collapse: collapse; }
td, th { padding: 4px 8px; }
hr { border: 0; border-top: 1px solid ${palette.border}; margin: 2em 0; }
blockquote { border-left: 3px solid ${palette.accent}; padding: 0 0 0 1em; color: ${palette.muted}; }
::selection { background: ${palette.selection}; }
mark.search-hit { background: ${palette.accentSoft} !important; color: inherit !important; padding: 0 2px; border-radius: 3px; }
mark.search-hit.ts-hit-flash { animation: tsHitFlash 1.4s ease-out 2; }
.tts-current { background: ${palette.accentSoft} !important; border-radius: 4px; transition: background .2s ease; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
@keyframes tsHitFlash {
  0% { background: ${palette.accent}; }
  60% { background: transparent; }
  100% { background: ${palette.accentSoft}; }
}
`.trim();
  }

  function injectStyles() {
    const doc = state.doc;
    if (!doc) return;
    let style = null;
    try { style = doc.querySelector('style[data-ts-reader]'); } catch { style = null; }
    if (!style) {
      style = createDocElement(doc, 'style');
      try { style.setAttribute('data-ts-reader', '1'); } catch { /* ignore */ }
      const head = doc.head || (doc.querySelector && doc.querySelector('head')) || doc.documentElement;
      if (!head) return;
      try { head.appendChild(style); } catch { /* ignore */ }
    }
    try { style.textContent = buildChapterCss(); } catch { /* ignore */ }
  }

  /* ------------------------------------------------------------------ */
  /* 滚动 / 进度                                                          */
  /* ------------------------------------------------------------------ */

  function currentScrollRatio() {
    const win = state.win;
    if (!win || !state.doc) return 0;
    const docEl = state.doc.documentElement;
    const scrollTop = Number(win.scrollY != null ? win.scrollY : (docEl ? docEl.scrollTop : 0)) || 0;
    const height = (docEl && docEl.scrollHeight) || 0;
    const view = win.innerHeight || 0;
    const max = height - view;
    if (max <= 0) return 0;
    return clamp(scrollTop / max, 0, 1);
  }

  function scrollToRatio(ratio) {
    const win = state.win;
    if (!win) return;
    const docEl = state.doc && state.doc.documentElement;
    const max = Math.max(0, ((docEl && docEl.scrollHeight) || 0) - (win.innerHeight || 0));
    try { win.scrollTo(0, Math.round(max * clamp(ratio, 0, 1))); } catch { /* ignore */ }
  }

  function scrollToTop() {
    try { if (state.win) state.win.scrollTo(0, 0); } catch { /* ignore */ }
  }

  function scrollToAnchor(hash) {
    if (!state.doc || !hash) return;
    const id = safeDecode(String(hash).replace(/^#/, ''));
    if (!id) return;
    let target = null;
    try { target = state.doc.getElementById ? state.doc.getElementById(id) : null; } catch { target = null; }
    if (!target) {
      try { target = state.doc.querySelector(`#${escapeSelector(id)}`); } catch { target = null; }
    }
    if (!target) {
      try {
        const named = state.doc.getElementsByName ? state.doc.getElementsByName(id) : null;
        if (named && named.length) target = named[0];
      } catch { /* ignore */ }
    }
    if (target) {
      try { target.scrollIntoView({ block: 'start' }); } catch { /* ignore */ }
      state.lastUserScroll = Date.now();
    }
  }

  function readingLocator() {
    if (!state.doc) return null;
    const nodes = Array.from(state.doc.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,blockquote')).filter(n=>n.textContent.trim());
    let i = nodes.findIndex(n=>n.getBoundingClientRect().bottom > 5);
    if(i < 0) i = nodes.length - 1;
    const n=nodes[i]; if(!n)return null;
    const r=n.getBoundingClientRect();
    return { paragraph:i, text:n.textContent.replace(/\s+/g,' ').trim().slice(0,100), offset:clamp(-r.top/Math.max(r.height,1),0,1) };
  }
  function restoreLocator(loc) {
    if(!loc || !state.doc)return false;
    const nodes=Array.from(state.doc.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,blockquote')).filter(n=>n.textContent.trim());
    let n=nodes[loc.paragraph];
    const text=n=>n.textContent.replace(/\s+/g,' ').trim().slice(0,100);
    if(!n || text(n)!==loc.text) n=nodes.find(n=>text(n)===loc.text);
    if(!n)return false;
    const r=n.getBoundingClientRect();state.win.scrollTo(0,state.win.scrollY+r.top+clamp(loc.offset||0,0,1)*r.height);return true;
  }
  function restorePosition() {
    const pending = state.pendingScroll || {};
    requestAnimationFrame(() => {
      if (restoreLocator(pending.locator)) return;
      if (pending.anchor) { scrollToAnchor(pending.anchor); return; }
      if (pending.scrollRatio > 0) scrollToRatio(pending.scrollRatio);
      else scrollToTop();
    });
    if (!pending.anchor && pending.scrollRatio > 0) {
      setTimeout(() => {
        if (!state.doc) return;
        if (Date.now() - state.lastUserScroll < 450) return;
        if (!restoreLocator(pending.locator)) scrollToRatio(pending.scrollRatio);
      }, 280);
    }
  }

  function computeProgress() {
    const ratio = currentScrollRatio();
    const total = state.spine.length || 1;
    const percent = clamp((state.index + ratio) / total, 0, 1);
    return {
      spineIndex: state.index,
      locator: readingLocator(),
      scrollRatio: Math.round(ratio * 10000) / 10000,
      percent: Math.round(percent * 10000) / 10000,
      chapterTitle: getChapterTitle(),
    };
  }

  const debouncedSave = debounce(() => { saveProgressNow(); }, 800);

  function scheduleSave() {
    if (!state.open) return;
    if (!state.restoring) { state.dirty = true; debouncedSave(); }
  }

  async function saveProgressNow() {
    if (!state.open || !state.book || !state.spine.length || !state.doc || state.restoring || !state.dirty) return;
    const progress = computeProgress();
    state.dirty = false;
    state.book.progress = progress;
    state.book.lastReadAt = Date.now();
    state.book.progressUpdatedAt = Date.now();
    if (typeof onBookProgress === 'function') {
      try { onBookProgress(state.book.id, progress); } catch (err) { console.error(err); }
    }
    try {
      await api.updateBook(state.book.id, { progress, lastReadAt: Date.now(), progressUpdatedAt: state.book.progressUpdatedAt });
    } catch (err) {
      state.dirty = true;
      const now = Date.now();
      if (now - lastProgressErrorToast > 20000) {
        lastProgressErrorToast = now;
        toast('阅读进度保存失败，稍后会自动重试', 'error');
      }
    }
  }

  function flushProgress() {
    debouncedSave.cancel();
    if (state.book) saveProgressNow();
  }

  function pageMetrics() {
    const win = state.win, doc = state.doc;
    if(!win || !doc) return {current:1,total:1,step:1,max:0,y:0};
    const height = Math.max(1,win.innerHeight);
    const step = Math.max(80,Math.floor(height - 32));
    const max = Math.max(0,Math.max(doc.documentElement.scrollHeight,doc.body?.scrollHeight||0)-height);
    const y = clamp(Number(win.scrollY)||0,0,max);
    const total = max <= 1 ? 1 : Math.ceil(max/step)+1;
    const current = max <= 1 ? 1 : y >= max-1 ? total : Math.min(total,Math.floor((y+1)/step)+1);
    return {current,total,step,max,y};
  }
  function updatePageUi() {
    const page = pageMetrics(), total = state.spine.length || 1;
    const percent = Math.round(clamp((state.index+currentScrollRatio())/total,0,1)*100);
    if(els.pageCounter) els.pageCounter.textContent = '本章 '+page.current+' / '+page.total+' 页';
    if(els.pageDetails) els.pageDetails.textContent = '第 '+(state.index+1)+' / '+total+' 章 · 全书 '+percent+'%';
    if(els.readingMode){els.readingMode.textContent=pagingMode()?'翻页模式':'滑动模式';els.readingMode.setAttribute('aria-label',pagingMode()?'切换到滑动阅读':'切换到翻页阅读');}
    if(els.settingReadingMode)els.settingReadingMode.value=getSettings().readingMode;
    if(els.prevPage) els.prevPage.disabled = !state.doc || (state.index===0 && page.y<=1);
    if(els.nextPage) els.nextPage.disabled = !state.doc || (state.index>=total-1 && page.y>=page.max-1);
  }
  async function animatePageChange(direction,change) {
    if(!mobileLayout()||!pagingMode()){await change();updateProgressUi();return;}
    if(pageTransition)return;
    const frame=els.frame;pageTransition=true;els.view.classList.add('page-is-turning');
    const sign=direction>0?-1:1;const duration=window.matchMedia('(prefers-reduced-motion: reduce)').matches?45:160;
    let out=null,incoming=null;
    try {
      if(frame.animate){out=frame.animate([{transform:'perspective(1000px) translateX(0) rotateY(0)',opacity:1,filter:'brightness(1)'},{transform:'perspective(1000px) translateX('+sign*25+'%) rotateY('+sign*15+'deg)',opacity:0,filter:'brightness(.82)'}],{duration,easing:'ease-in',fill:'forwards'});await out.finished;}
      if(!state.open)return;
      await change();
      if(!state.open)return;
      if(frame.animate){incoming=frame.animate([{transform:'perspective(1000px) translateX('+(-sign*25)+'%) rotateY('+(-sign*15)+'deg)',opacity:0,filter:'brightness(.85)'},{transform:'perspective(1000px) translateX(0) rotateY(0)',opacity:1,filter:'brightness(1)'}],{duration:duration+40,easing:'ease-out',fill:'forwards'});out?.cancel();await incoming.finished;}
    }catch(error){if(error?.name!=='AbortError')console.error('[page animation]',error);}finally{out?.cancel();incoming?.cancel();pageTransition=false;els.view.classList.remove('page-is-turning');if(state.open){updateProgressUi();revealToolbar(true);}}
  }
  function turnPage(direction) {
    if(!state.open || !state.win || !state.doc || pageTransition || Date.now()<turnBusyUntil)return;
    turnBusyUntil=Date.now()+170;
    if(tts && tts.isActive())tts.stop({silent:true});
    const p=pageMetrics();
    if(direction>0 && p.y>=p.max-1){if(state.index<state.spine.length-1)animatePageChange(direction,()=>loadChapter(state.index+1));return;}
    if(direction<0 && p.y<=1){if(state.index>0)animatePageChange(direction,()=>loadChapter(state.index-1,{scrollRatio:1}));return;}
    let target;
    if(direction>0) target=Math.min(p.max,Math.floor((p.y+1)/p.step+1)*p.step);
    else target=p.y>=p.max-1 ? Math.max(0,(p.total-2)*p.step) : Math.max(0,(Math.ceil((p.y-1)/p.step)-1)*p.step);
    if(mobileLayout() && pagingMode())animatePageChange(direction,()=>{state.win.scrollTo(0,target);updateProgressUi();scheduleSave();});
    else{state.win.scrollTo({top:target,behavior:'smooth'});updateProgressUi();scheduleSave();revealToolbar(true);}
  }
  function updateProgressUi() {
    updatePageUi();
    const total = state.spine.length || 1;
    if (!state.dragging) {
      const overall = clamp((state.index + currentScrollRatio()) / total, 0, 1);
      els.progress.value = String(Math.round(overall * 1000));
      els.percent.textContent = `${Math.round(overall * 100)}%`;
      els.progress.style.setProperty('--p', `${(overall * 100).toFixed(2)}%`);
    }
    els.chapterIndicator.textContent = `第 ${state.index + 1}/${total} 章`;
  }

  function updateChapterChrome() {
    updatePageUi();
    const total = state.spine.length || 1;
    const progress = (state.book && state.book.progress) || {};
    const overall = clamp((state.index + clamp(progress.scrollRatio == null ? 0 : progress.scrollRatio, 0, 1)) / total, 0, 1);
    els.chapterIndicator.textContent = `第 ${state.index + 1}/${total} 章`;
    els.progress.value = String(Math.round(overall * 1000));
    els.progress.style.setProperty('--p', `${(overall * 100).toFixed(2)}%`);
    els.percent.textContent = `${Math.round(overall * 100)}%`;
    els.prevBtn.disabled = state.index <= 0;
    els.nextBtn.disabled = state.index >= total - 1;
  }

  /* ------------------------------------------------------------------ */
  /* iframe 事件                                                          */
  /* ------------------------------------------------------------------ */

  function bindFrameEvents() {
    const doc = state.doc;
    const win = state.win;
    if (!doc || !win) return;
    pageLayoutObserver?.disconnect();
    if(window.MutationObserver){pageLayoutObserver=new MutationObserver(()=>requestAnimationFrame(updatePageUi));pageLayoutObserver.observe(doc.documentElement,{childList:true,subtree:true,characterData:true});}
    doc.fonts?.ready.then(()=>{if(state.doc===doc)updatePageUi();});
    doc.fonts?.addEventListener('loadingdone',updatePageUi);
    win.addEventListener('resize',updatePageUi,{passive:true});
    doc.addEventListener('load',updatePageUi,true);
    let touchStart=null,ignoreClickUntil=0;
    doc.addEventListener('touchstart',event=>{if(event.touches.length!==1){touchStart=null;return;}const t=event.touches[0];touchStart={x:t.clientX,y:t.clientY,time:Date.now(),target:event.target};},{passive:true});
    doc.addEventListener('touchmove',event=>{if(!mobileLayout()||!touchStart||event.touches.length!==1)return;
      if(pagingMode() && Math.abs(event.touches[0].clientY-touchStart.y)>10 && Math.abs(event.touches[0].clientY-touchStart.y)>Math.abs(event.touches[0].clientX-touchStart.x)){if(!String(win.getSelection?.()||'').trim())event.preventDefault();return;}
      if(!pagingMode())return;const t=event.touches[0];const dx=t.clientX-touchStart.x,dy=t.clientY-touchStart.y;if(Math.abs(dx)>20&&Math.abs(dx)>Math.abs(dy)*1.8)event.preventDefault();},{passive:false});
    doc.addEventListener('touchend',event=>{
      if(!mobileLayout() || !pagingMode() || !touchStart || event.changedTouches.length!==1)return;
      const start=touchStart;touchStart=null;const t=event.changedTouches[0];const dx=t.clientX-start.x,dy=t.clientY-start.y;
      if(Date.now()-start.time>650 || start.target?.closest?.('a,button,input,textarea,select,video,audio'))return;
      if(String(win.getSelection?.()||'').trim())return;
      if(Math.abs(dx)>60 && Math.abs(dx)>Math.abs(dy)*1.8){event.preventDefault();ignoreClickUntil=Date.now()+450;turnPage(dx<0?1:-1);}
    },{passive:false});
    doc.addEventListener('click',event=>{
      if(!mobileLayout() || !pagingMode() || event.defaultPrevented)return;
      if(Date.now()<ignoreClickUntil){event.preventDefault();return;}
      if(event.target?.closest?.('a,button,input,textarea,select,video,audio') || String(win.getSelection?.()||'').trim())return;
      const width=win.innerWidth;
      if(event.clientX<width*.18)turnPage(-1);else if(event.clientX>width*.82)turnPage(1);
    });
    try { doc.addEventListener('click', onFrameClick, true); } catch { /* ignore */ }
    try { win.addEventListener('scroll', onFrameScroll, { passive: true }); } catch { /* ignore */ }
    try { doc.addEventListener('mouseup', onSideButton, true); doc.addEventListener('mousedown', preventSideButton, true); doc.addEventListener('auxclick', preventSideButton, true); } catch {}
    try { win.addEventListener('keydown', onFrameKeydown, true); } catch { /* ignore */ }
    try { win.addEventListener('mousemove', onActivity, { passive: true }); } catch { /* ignore */ }
    try { win.addEventListener('touchstart', onActivity, { passive: true }); } catch { /* ignore */ }
  }

  function preventSideButton(e) { if(state.open && (e.button===3||e.button===4)){e.preventDefault(); e.stopPropagation();} }
  let lastSidePage=0;
  function sidePage(direction){if(Date.now()-lastSidePage<180)return;lastSidePage=Date.now();scrollByPages(direction);}
  function onSideButton(e) { if(!state.open || (e.button!==3&&e.button!==4))return;preventSideButton(e); sidePage(e.button===4?1:-1); }
  window.addEventListener('stella-side-page',e=>{if(state.open)sidePage(e.detail);});
  document.addEventListener('mouseup',onSideButton,true);
  document.addEventListener('mousedown',preventSideButton,true);
  document.addEventListener('auxclick',preventSideButton,true);
  function onFrameScroll() {
    state.lastUserScroll = Date.now();
    updateProgressUi();
    scheduleSave();
  }

  function onFrameKeydown(event) {
    if (typeof frameKeyHandler === 'function') frameKeyHandler(event);
  }

  function onFrameClick(event) {
    const target = event.target;
    const anchor = target && typeof target.closest === 'function' ? target.closest('a[href]') : null;
    if (!anchor) return;
    const href = anchor.getAttribute('href') || '';
    if (!href) return;
    if (href.startsWith('javascript:')) { event.preventDefault(); return; }
    if (href.startsWith('#')) { event.preventDefault(); scrollToAnchor(href); return; }
    event.preventDefault();
    if (/^(https?:|mailto:|tel:)/i.test(href)) { openExternal(href); return; }
    navigateInternal(href);
  }

  function navigateInternal(href) {
    if (!state.book) return;
    const chapterPath = state.spine[state.index] && state.spine[state.index].path;
    if (!chapterPath) return;
    let url;
    try {
      url = new URL(href, new URL(api.resUrl(state.book.id, chapterPath), location.origin));
    } catch { toast('无法打开书内链接', 'error'); return; }
    if (url.origin !== location.origin) { openExternal(url.href); return; }
    const prefix = `/api/books/${encodeURIComponent(state.book.id)}/res/`;
    const decodedPath = safeDecode(url.pathname);
    const prefixDecoded = safeDecode(prefix);
    if (!decodedPath.startsWith(prefixDecoded)) { openExternal(url.href); return; }
    const epubPath = decodedPath.slice(prefixDecoded.length);
    const fragment = url.hash || '';
    const targetIndex = resolveSpineIndex(epubPath);
    if (targetIndex === state.index) { scrollToAnchor(fragment); return; }
    if (targetIndex >= 0) { loadChapter(targetIndex, { anchor: fragment || null }); return; }
    navigateRaw(url.href, fragment);
  }

  async function navigateRaw(url, fragment) {
    const seq = ++state.loadSeq;
    if (tts) tts.stop({ silent: true });
    showVeil(true);
    const promise = waitForFrameLoad(seq, url);
    try {
      els.frame.src = url;
      await promise;
    } catch {
      showVeil(false);
      return;
    }
    if (seq !== state.loadSeq) return;
    try {
      state.doc = els.frame.contentDocument;
      state.win = els.frame.contentWindow;
      injectStyles();
      bindFrameEvents();
      if (fragment) scrollToAnchor(fragment); else scrollToTop();
      hideVeilSoon();
      updateProgressUi();
    } catch { showVeil(false); }
  }

  /* ------------------------------------------------------------------ */
  /* 搜索                                                             */
  /* ------------------------------------------------------------------ */

  function setSearchState(name) {
    els.searchIdle.hidden = name !== 'idle';
    els.searchLoading.hidden = name !== 'loading';
    els.searchEmpty.hidden = name !== 'empty';
    els.searchResults.hidden = name !== 'results';
    els.searchSummary.hidden = name !== 'results';
  }

  const debouncedSearch = debounce((query) => { performSearch(query); }, 300);

  async function performSearch(rawQuery) {
    if (!state.book) return;
    const query = String(rawQuery == null ? '' : rawQuery).trim();
    const token = ++state.searchToken;
    state.searchQuery = query;
    if (!query) {
      els.searchResults.innerHTML = '';
      els.searchSummary.textContent = '';
      setSearchState('idle');
      return;
    }
    setSearchState('loading');
    try {
      const data = await api.search(state.book.id, query);
      if (token !== state.searchToken) return;
      const results = data && Array.isArray(data.results) ? data.results : [];
      renderSearchResults(results, query);
    } catch {
      if (token !== state.searchToken) return;
      setSearchState('idle');
    }
  }

  function snippetHtml(snippet) {
    const escaped = escapeHtml(snippet || '');
    return escaped
      .replace(/&lt;mark&gt;/g, '<mark>')
      .replace(/&lt;\/mark&gt;/g, '</mark>');
  }

  function renderSearchResults(results, query) {
    if (!results.length) {
      els.searchResults.innerHTML = '';
      els.searchSummary.textContent = '';
      setSearchState('empty');
      return;
    }
    els.searchSummary.textContent = `找到 ${results.length} 处结果 · 点击跳转并高亮`;
    els.searchResults.innerHTML = results.map((item, index) => {
      const spineItem = state.spine[item.spineIndex] || {};
      const title = item.chapterTitle || spineItem.title || `第 ${(Number(item.spineIndex) || 0) + 1} 章`;
      return `<button type="button" class="search-result" data-result-index="${index}">
        <span class="search-result-head">${icon('bookOpen', 14)}${escapeHtml(title)}</span>
        <span class="search-result-snippet">${snippetHtml(item.snippet)}</span>
      </button>`;
    }).join('');
    Array.from(els.searchResults.querySelectorAll('.search-result')).forEach((btn) => {
      const item = results[Number(btn.dataset.resultIndex)];
      if (!item) return;
      btn.addEventListener('click', () => {
        closePanel(els.searchPanel);
        loadChapter(Number(item.spineIndex) || 0, { highlightTerm: query });
      });
    });
    setSearchState('results');
  }

  function highlightTermInDoc(term) {
    const doc = state.doc;
    if (!doc || !term) return;
    const query = String(term).trim();
    if (!query) return;
    // 清掉上一次搜索结果
    try {
      doc.querySelectorAll('mark.search-hit').forEach((mark) => {
        const parent = mark.parentNode;
        if (!parent) return;
        parent.replaceChild(doc.createTextNode(mark.textContent || ''), mark);
      });
    } catch { /* ignore */ }

    const root = doc.body || doc.documentElement;
    if (!root) return;
    let walker;
    try {
      walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = String(parent.localName || parent.tagName || '').toLowerCase();
          if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'svg') return NodeFilter.FILTER_REJECT;
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
    } catch { return; }

    const textNodes = [];
    let node = walker.nextNode();
    while (node && textNodes.length < 600) { textNodes.push(node); node = walker.nextNode(); }

    const lowerQuery = query.toLowerCase();
    const marks = [];
    for (const textNode of textNodes) {
      const value = textNode.nodeValue || '';
      const lower = value.toLowerCase();
      if (!lower.includes(lowerQuery)) continue;
      const fragment = doc.createDocumentFragment();
      let last = 0;
      let index = lower.indexOf(lowerQuery);
      let count = 0;
      while (index >= 0 && count < 20) {
        if (index > last) fragment.appendChild(doc.createTextNode(value.slice(last, index)));
        const mark = createDocElement(doc, 'mark');
        mark.className = 'search-hit';
        mark.textContent = value.slice(index, index + query.length);
        fragment.appendChild(mark);
        marks.push(mark);
        last = index + query.length;
        count += 1;
        index = lower.indexOf(lowerQuery, last);
      }
      if (!count) continue;
      if (last < value.length) fragment.appendChild(doc.createTextNode(value.slice(last)));
      if (textNode.parentNode) textNode.parentNode.replaceChild(fragment, textNode);
      if (marks.length >= 120) break;
    }

    if (marks.length) {
      const first = marks[0];
      try { first.scrollIntoView({ block: 'center' }); } catch { /* ignore */ }
      try { first.classList.add('ts-hit-flash'); } catch { /* ignore */ }
      setTimeout(() => { try { first.classList.remove('ts-hit-flash'); } catch { /* ignore */ } }, 3400);
      toast(`已定位 ${marks.length} 处“${query}”`, 'info', 2200);
    } else {
      toast(`本章未找到“${query}”`, 'info', 2400);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 目录                                                             */
  /* ------------------------------------------------------------------ */

  function normalizeEpubPath(path) {
    if (!path) return '';
    let value = String(path);
    const hash = value.indexOf('#');
    if (hash >= 0) value = value.slice(0, hash);
    value = safeDecode(value);
    return value.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/{2,}/g, '/').trim();
  }

  function spinePathMap() {
    const map = new Map();
    state.spine.forEach((item, index) => {
      const key = normalizeEpubPath(item.path);
      if (key && !map.has(key)) map.set(key, index);
    });
    return map;
  }

  function resolveSpineIndex(path) {
    const key = normalizeEpubPath(path);
    if (!key) return -1;
    const map = spinePathMap();
    if (map.has(key)) return map.get(key);
    const base = key.split('/').pop();
    for (const [candidate, index] of map.entries()) {
      if (candidate.split('/').pop() === base) return index;
    }
    return -1;
  }

  function flattenToc(items, depth, out) {
    (Array.isArray(items) ? items : []).forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const itemDepth = Number.isFinite(Number(item.depth)) ? Number(item.depth) : depth;
      const children = Array.isArray(item.children) ? item.children : [];
      out.push({
        title: String(item.title || ''),
        path: String(item.path || ''),
        depth: itemDepth,
        spineIndex: resolveSpineIndex(item.path),
        hasChildren: children.length > 0,
      });
      if (children.length) {
        flattenToc(children, itemDepth + 1, out);
      }
    });
    return out;
  }

  function renderToc() {
    let items = flattenToc(state.toc, 0, []).filter((item) => item.title || item.spineIndex >= 0);
    if (!items.length) {
      items = state.spine.map((chapter, index) => ({
        title: chapter.title || `第 ${index + 1} 章`,
        path: chapter.path,
        depth: 0,
        spineIndex: index,
        hasChildren: false,
      }));
    }
    state.tocItems = items;
    const leafCount = items.filter((item) => !item.hasChildren && item.spineIndex >= 0).length;
    els.tocCount.textContent = items.length ? `${leafCount || items.length} 章` : '';
    els.tocEmpty.hidden = items.length > 0;
    els.tocList.innerHTML = items.map((item) => {
      const depth = clamp(item.depth, 0, 6);
      const pad = 10 + depth * 15;
      const clickable = item.spineIndex >= 0;
      const hashIndex = item.path.indexOf('#');
      const fragment = hashIndex >= 0 ? item.path.slice(hashIndex + 1) : '';
      if (!clickable) {
        return `<div class="toc-item is-group" style="padding-left:${pad}px"><span class="toc-item-text">${escapeHtml(item.title || '未命名')}</span></div>`;
      }
      const classes = ['toc-item'];
      if (item.hasChildren) classes.push('has-children');
      return `<button type="button" class="${classes.join(' ')}" data-spine="${item.spineIndex}" data-leaf="${item.hasChildren ? '0' : '1'}" data-fragment="${escapeHtml(fragment)}" style="padding-left:${pad}px" title="${escapeHtml(item.title)}"><span class="toc-item-text">${escapeHtml(item.title || '未命名章节')}</span></button>`;
    }).join('');
    renderTocActive();
  }

  function renderTocActive() {
    if (!els.tocList) return;
    let first = null;
    Array.from(els.tocList.querySelectorAll('.toc-item[data-spine]')).forEach((node) => {
      const active = Number(node.dataset.spine) === state.index && node.dataset.leaf === '1';
      node.classList.toggle('active', active);
      if (active && !first) first = node;
    });
    if (first && els.tocDrawer.classList.contains('open')) {
      try { first.scrollIntoView({ block: 'nearest' }); } catch { /* ignore */ }
    }
  }

  function setTocOpen(open) {
    els.tocDrawer.classList.toggle('open', !!open);
    els.tocDrawer.setAttribute('aria-hidden', open ? 'false' : 'true');
    els.tocBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    els.tocBtn.classList.toggle('active', !!open);
    if (open) {
      renderTocActive();
      const activeNode = els.tocList.querySelector('.toc-item.active');
      if (activeNode) setTimeout(() => { try { activeNode.scrollIntoView({ block: 'center' }); } catch { /* ignore */ } }, 320);
    }
  }

  function isTocOpen() { return els.tocDrawer.classList.contains('open'); }

  /* ------------------------------------------------------------------ */
  /* 面板 / 工具栏                                                        */
  /* ------------------------------------------------------------------ */

  function openSearch() {
    if (!state.open) return;
    setTocOpen(false);
    openPanel(els.searchPanel);
    setTimeout(() => {
      els.searchInput.focus();
      els.searchInput.select();
    }, 160);
  }

  function onActivity() {
    if (!state.open) return;
    revealToolbar();
  }

  function revealToolbar(persist = false) {
    els.view.classList.remove('toolbar-hidden');
    clearTimeout(toolbarTimer);
    if (persist || HEADLESS) return;
    toolbarTimer = setTimeout(() => {
      if (!state.open) return;
      if (document.body.classList.contains('panel-open')) return;
      if (tts && tts.isActive()) return;
      if (document.activeElement && els.toolbar.contains(document.activeElement)) return;
      els.view.classList.add('toolbar-hidden');
    }, 3400);
  }

  /* ------------------------------------------------------------------ */
  /* 公共操作                                                             */
  /* ------------------------------------------------------------------ */

  function prevChapter() {
    if (!state.open || state.index <= 0) {
      if (state.open) toast('已经是第一章了', 'info');
      return;
    }
    loadChapter(state.index - 1);
  }

  function nextChapter() {
    if (!state.open) return;
    if (state.index >= state.spine.length - 1) { toast('已经是最后一章了', 'info'); return; }
    loadChapter(state.index + 1);
  }

  async function loadNextChapterForTts() {
    if (!state.open || state.index + 1 >= state.spine.length) return false;
    return loadChapter(state.index + 1, { ttsDriven: true });
  }

  function scrollByPages(pages) {
    if (!state.win) return;
    if(mobileLayout()&&pagingMode()){turnPage(pages>0?1:-1);return;}
    const ratio = currentScrollRatio();
    if (pages > 0 && ratio >= .999 && state.index < state.spine.length-1) { nextChapter(); return; }
    if (pages < 0 && ratio <= .001 && state.index > 0) { loadChapter(state.index-1,{scrollRatio:1}); return; }
    const amount = (state.win.innerHeight || 600) * 0.9 * pages;
    try { state.win.scrollBy({ top: amount, behavior: 'smooth' }); }
    catch { try { state.win.scrollBy(0, amount); } catch { /* ignore */ } }
  }

  function closeOverlays() {
    closeAllPanels();
    if (isTocOpen()) { setTocOpen(false); return true; }
    if (tts && tts.isPanelOpen()) { tts.closePanel(); return true; }
    return false;
  }

  function getChapterTitle() {
    // 优先使用目录中的叶子标题（spine.title 可能来自目录父级，如「第一部」）
    const tocItem = state.tocItems.find((item) => item.spineIndex === state.index && item.title && !item.hasChildren)
      || state.tocItems.find((item) => item.spineIndex === state.index && item.title);
    if (tocItem) return tocItem.title;
    const chapter = state.spine[state.index];
    if (chapter && chapter.title) return chapter.title;
    return `第 ${state.index + 1} 章`;
  }

  function getChapterMeta() {
    const chapter = state.spine[state.index] || {};
    return {
      title: getChapterTitle(),
      index: state.index,
      total: state.spine.length,
      path: chapter.path || '',
      bookId: state.book ? state.book.id : '',
    };
  }

  /* ------------------------------------------------------------------ */
  /* 事件绑定                                                             */
  /* ------------------------------------------------------------------ */

  els.readingMode?.addEventListener('click',()=>updateSettings({readingMode:pagingMode()?'scroll':'paged'}));
  els.settingReadingMode?.addEventListener('change',()=>updateSettings({readingMode:els.settingReadingMode.value}));
  els.prevPage?.addEventListener('click',()=>turnPage(-1));
  els.nextPage?.addEventListener('click',()=>turnPage(1));
  window.addEventListener('resize',()=>setTimeout(updatePageUi,100),{passive:true});
  els.btnBackLibrary.addEventListener('click', () => close());
  els.tocBtn.addEventListener('click', () => setTocOpen(!isTocOpen()));
  els.btnCloseToc.addEventListener('click', () => setTocOpen(false));
  els.prevBtn.addEventListener('click', () => prevChapter());
  els.nextBtn.addEventListener('click', () => nextChapter());
  els.btnSearch.addEventListener('click', openSearch);
  els.btnCloseSearch.addEventListener('click', () => closePanel(els.searchPanel));
  els.searchInput.addEventListener('input', () => {
    els.btnClearSearch.hidden = !els.searchInput.value;
    debouncedSearch(els.searchInput.value);
  });
  els.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      debouncedSearch.cancel();
      performSearch(els.searchInput.value);
    }
  });
  els.btnClearSearch.addEventListener('click', () => {
    els.searchInput.value = '';
    els.btnClearSearch.hidden = true;
    debouncedSearch.cancel();
    performSearch('');
    els.searchInput.focus();
  });

  els.tocList.addEventListener('click', (event) => {
    const btn = event.target && typeof event.target.closest === 'function'
      ? event.target.closest('.toc-item[data-spine]') : null;
    if (!btn) return;
    const targetIndex = Number(btn.dataset.spine);
    const fragment = btn.dataset.fragment || '';
    setTocOpen(false);
    if (targetIndex === state.index) {
      if (fragment) scrollToAnchor(fragment); else scrollToTop();
      return;
    }
    loadChapter(targetIndex, { anchor: fragment ? `#${fragment}` : null });
  });

  els.progress.addEventListener('input', () => {
    if (!state.spine.length) return;
    state.dragging = true;
    const value = clamp(Number(els.progress.value) / 1000, 0, 1);
    const total = state.spine.length;
    const targetIndex = clamp(Math.floor(value * total), 0, total - 1);
    let ratio = value * total - targetIndex;
    if (value >= 0.9999) ratio = 1;
    state.dragTarget = { index: targetIndex, ratio: clamp(ratio, 0, 1) };
    els.progress.style.setProperty('--p', `${(value * 100).toFixed(2)}%`);
    els.percent.textContent = `${Math.round(value * 100)}%`;
    els.chapterIndicator.textContent = `第 ${targetIndex + 1}/${total} 章`;
  });

  els.progress.addEventListener('change', () => {
    state.dragging = false;
    const target = state.dragTarget;
    state.dragTarget = null;
    if (!target) return;
    if (target.index === state.index) {
      scrollToRatio(target.ratio);
      updateProgressUi();
    } else {
      loadChapter(target.index, { scrollRatio: target.ratio });
    }
  });

  document.addEventListener('mousemove', onActivity, { passive: true });
  document.addEventListener('wheel', onActivity, { passive: true });
  document.addEventListener('keydown', onActivity, true);

  registerPanel(els.searchPanel);

  subscribe(() => {
    if (state.doc) { injectStyles(); requestAnimationFrame(updatePageUi); }
  });

  /* ------------------------------------------------------------------ */
  /* 对外 API                                                             */
  /* ------------------------------------------------------------------ */

  return {
    open,
    close,
    isOpen: () => state.open,
    prevChapter,
    nextChapter,
    scrollByPages,
    turnPage,
    getPageMetrics: pageMetrics,
    loadNextChapterForTts,
    flushProgress,
    saveProgress: saveProgressNow,
    getProgress: computeProgress,
    isDirty: () => state.dirty || state.restoring,
    applyRemote: async (bookId) => { state.restoring=true; state.doc=null; await open(bookId); },
    setKeyHandler(fn) { frameKeyHandler = fn; },
    getDoc: () => state.doc,
    getChapterMeta,
    getBook: () => state.book,
    openSearch,
    openToc: () => setTocOpen(true),
    closeToc: () => setTocOpen(false),
    toggleToc: () => setTocOpen(!isTocOpen()),
    isTocOpen,
    closeOverlays,
    getSpine: () => state.spine.slice(),
    getIndex: () => state.index,
    getScrollRatio: currentScrollRatio,
    reloadCurrent: () => loadChapter(state.index, { scrollRatio: currentScrollRatio() }),
  };
}
