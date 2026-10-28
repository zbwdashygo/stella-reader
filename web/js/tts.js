/* 朗读引擎：speechSynthesis 逐段朗读 + 高亮 + 自动翻章；无中文语音时回退 /api/tts（SAPI） */

import { $, clamp, toast } from './util.js';
import { icon } from './icons.js';
import { getSettings, updateSettings, subscribe } from './settings.js';

const PARA_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,li,blockquote';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

function normalizeText(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

function isZhVoice(voice) {
  if (!voice) return false;
  const lang = String(voice.lang || '').toLowerCase();
  const name = String(voice.name || '');
  return /^zh([-_]|$)/.test(lang) || /chinese|中文|普通话|國語|国语/i.test(name);
}

function collectParagraphs(doc) {
  if (!doc) return [];
  const root = doc.body || doc.documentElement;
  if (!root || !root.querySelectorAll) return [];
  let nodes = [];
  try { nodes = Array.from(root.querySelectorAll(PARA_SELECTOR)); } catch { nodes = []; }

  if (!nodes.length) {
    try {
      nodes = Array.from(root.children || []).filter((el) => {
        const tag = String(el.localName || el.tagName || '').toLowerCase();
        if (['script', 'style', 'svg', 'img', 'video', 'audio', 'nav', 'head'].includes(tag)) return false;
        return !!normalizeText(el.textContent);
      });
    } catch { nodes = []; }
  }

  const candidateSet = new Set(nodes);
  const result = [];
  for (const el of nodes) {
    const text = normalizeText(el.textContent);
    if (!text) continue;
    // 嵌套段落（如 li > p、blockquote > p）只读最外层，避免重复
    let parent = el.parentElement;
    let nested = false;
    while (parent) {
      if (candidateSet.has(parent)) { nested = true; break; }
      parent = parent.parentElement;
    }
    if (nested) continue;
    // 跳过隐藏元素
    try {
      if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) continue;
    } catch { /* ignore */ }
    for(let i=0;i<text.length;i+=400) result.push({ el, text:text.slice(i,i+400) });
  }
  return result;
}

export function createTtsController(deps = {}) {
  const synth = window.speechSynthesis || null;
  const audio = $('#ttsAudio');

  const state = {
    status: 'idle',            // idle | loading | playing | paused
    doc: null,
    chapter: { title: '尚未开始', index: 0, total: 0 },
    paragraphs: [],
    index: 0,
    currentText: '',
    gen: 0,
    engine: 'browser',         // browser | sapi
    advancing: false,
    voices: [],
    extraVoices: [],
    panelOpen: false,
    sapiUnavailable: false,
    audioUrl: null,
    ttsAbort: null,
    fallbackVoice: null,
    speechRoute: 'direct',
    errorMessage: '',
  };

  const stateListeners = new Set();
  const voiceListeners = new Set();

  function getState() {
    return {
      status: state.status,
      chapter: state.chapter,
      index: state.index,
      total: state.paragraphs.length,
      text: state.currentText,
      engine: state.engine,
      advancing: state.advancing,
      sapiUnavailable: state.sapiUnavailable,
      panelOpen: state.panelOpen,
      fallbackVoice: state.fallbackVoice?.name || '',
      speechRoute: state.speechRoute,
      errorMessage: state.errorMessage,
    };
  }

  function emit() {
    const snapshot = getState();
    stateListeners.forEach((fn) => { try { fn(snapshot); } catch (err) { console.error('[tts listener]', err); } });
  }

  function subscribeState(fn) {
    stateListeners.add(fn);
    try { fn(getState()); } catch { /* ignore */ }
    return () => stateListeners.delete(fn);
  }

  function setStatus(status) {
    state.status = status;
    emit();
  }

  /* ---------------- 音色 ---------------- */

  function getVoices() { return state.voices.slice(); }

  function emitVoices() {
    const list = getVoices();
    voiceListeners.forEach((fn) => { try { fn(list); } catch (err) { console.error('[tts voices]', err); } });
  }

  function onVoicesChanged(fn) {
    voiceListeners.add(fn);
    try { fn(getVoices()); } catch { /* ignore */ }
    return () => voiceListeners.delete(fn);
  }

  function refreshVoices() {
    if (!synth) { state.voices = state.extraVoices.slice(); emitVoices(); return; }
    let list = [];
    try { list = synth.getVoices() || []; } catch { list = []; }
    state.voices = [...list, ...state.extraVoices].sort((a, b) => {
      const za = isZhVoice(a) ? 0 : 1;
      const zb = isZhVoice(b) ? 0 : 1;
      if (za !== zb) return za - zb;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    emitVoices();
    emit();
  }

  if (synth) {
    refreshVoices();
    try {
      if (typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', refreshVoices);
      else synth.onvoiceschanged = refreshVoices;
    } catch { /* ignore */ }
    [250, 900, 2200].forEach((ms) => setTimeout(refreshVoices, ms));
  }

  async function loadExtraVoices(event){
    try {
      const local=await (await fetch('/api/voices'+(window.AndroidBridge&&event?.detail?.force?'?refresh=1':''))).json();
      let remote=[];if(window.AndroidBridge && window.stellaRemote && !(local.directOnlineCount>0)){try{remote=(await(await window.stellaRemote('/voices')).json()).voices||[];}catch{}}
      if(window.AndroidBridge&&!getSettings().ttsVoice&&!(local.voices||[]).some(v=>v.voiceURI.startsWith('native:')&&isZhVoice(v))){const fallback=(local.voices||[]).find(v=>v.voiceURI==='edge:zh-CN-XiaoxiaoNeural')||(local.voices||[]).find(v=>v.voiceURI.startsWith('edge:')&&isZhVoice(v));if(fallback)updateSettings({ttsVoice:fallback.voiceURI});}
      state.extraVoices=Array.from(new Map([...(local.voices||[]),...remote].map(v=>[v.voiceURI,v])).values());refreshVoices();
      window.dispatchEvent(new CustomEvent('stella-voices-status',{detail:{count:state.voices.length,directOnlineCount:local.directOnlineCount||0,warning:local.warning||''}}));
    }catch{}
  }
  setTimeout(loadExtraVoices,500);
  window.addEventListener('stella-voices-refresh',loadExtraVoices);
  window.addEventListener('stella-speech',event=>{const x=event.detail||{};if(x.gen!==state.gen)return;if(x.status==='done')advance();else if(x.status==='paused'){state.gen+=1;setStatus('paused');}else if(x.status==='error')failSapi('所选安卓声音不可用，请安装语言包或切换声音');});
  function waitForVoices(timeout = 1000) {
    if (!synth) return Promise.resolve([]);
    if (state.voices.length) return Promise.resolve(state.voices);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        refreshVoices();
        resolve(state.voices);
      };
      const timer = setTimeout(finish, timeout);
      const handler = () => { clearTimeout(timer); finish(); };
      try {
        if (typeof synth.addEventListener === 'function') {
          synth.addEventListener('voiceschanged', handler, { once: true });
          setTimeout(() => { try { synth.removeEventListener('voiceschanged', handler); } catch { /* ignore */ } }, timeout + 80);
        } else {
          const old = synth.onvoiceschanged;
          synth.onvoiceschanged = () => { try { if (typeof old === 'function') old(); } catch { /* ignore */ } handler(); };
        }
      } catch { /* ignore */ }
      refreshVoices();
      if (state.voices.length) { clearTimeout(timer); finish(); }
    });
  }

  function pickVoice() {
    const uri = getSettings().ttsVoice;
    if (uri) {
      const found = state.voices.find((voice) => voice.voiceURI === uri);
      if (found) return found;
    }
    return state.voices.find((voice) => isZhVoice(voice)) || null;
  }

  function zhVoiceCount() {
    return state.voices.filter((voice) => isZhVoice(voice)).length;
  }

  function decideEngine() {
    const uri=getSettings().ttsVoice||'';
    if(state.fallbackVoice)return 'native';
    if(uri.startsWith('native:') || (window.AndroidBridge && !uri))return 'native';
    if(/^(edge|pc|azure|openai):/.test(uri))return 'sapi';
    if (!synth) return 'sapi';
    if (pickVoice()) return 'browser';
    if (!state.voices.length) return 'sapi';
    // 有语音但都不是中文 → 按需求回退系统语音
    return zhVoiceCount() > 0 ? 'browser' : 'sapi';
  }

  /* ---------------- 音频清理 ---------------- */

  function revokeAudioUrl() {
    if (state.audioUrl) {
      try { URL.revokeObjectURL(state.audioUrl); } catch { /* ignore */ }
      state.audioUrl = null;
    }
  }

  function cancelPlayback() {
    state.gen += 1;
    state.ttsAbort?.abort();state.ttsAbort=null;
    try{window.AndroidBridge?.stopSpeech();}catch{}
    if (synth) { try { synth.cancel(); } catch { /* ignore */ } }
    if (audio) {
      try { audio.pause(); } catch { /* ignore */ }
      audio.onended = null;
      audio.onerror = null;
      try { audio.removeAttribute('src'); audio.load(); } catch { /* ignore */ }
    }
    revokeAudioUrl();
  }

  /* ---------------- 高亮 ---------------- */

  function clearHighlight() {
    if (!state.doc) return;
    try {
      state.doc.querySelectorAll('.tts-current').forEach((node) => node.classList.remove('tts-current'));
    } catch { /* ignore */ }
  }

  function applyHighlight(el) {
    clearHighlight();
    if (!el) return;
    if (!getSettings().ttsHighlight) return;
    try {
      el.classList.add('tts-current');
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch { /* ignore */ }
  }

  /* ---------------- 章节 ---------------- */

  function setChapter(doc, meta, options = {}) {
    cancelPlayback();
    clearHighlight();
    state.sapiUnavailable = false;
    state.doc = doc || null;
    const m = meta || {};
    state.chapter = {
      title: m.title || '未命名章节',
      index: Number.isFinite(m.index) ? m.index : 0,
      total: Number.isFinite(m.total) ? m.total : 0,
    };
    state.paragraphs = collectParagraphs(doc);
    state.index = 0;
    state.currentText = state.paragraphs.length ? state.paragraphs[0].text : '';
    if (options.autoplay) start({preserveRoute:true});
    else setStatus('idle');
  }

  /* ---------------- 播放 ---------------- */

  async function start(options = {}) {
    if (state.status === 'paused') { resume(); return; }
    if (state.status === 'playing' || state.status === 'loading') return;
    if (!state.doc) { toast('请先打开一本书再开始朗读', 'info'); return; }
    if (!state.paragraphs.length) state.paragraphs = collectParagraphs(state.doc);
    if (!state.paragraphs.length) { toast('本章暂无可朗读的文字', 'info'); setStatus('idle'); return; }

    const needWait = !!synth && state.voices.length === 0;
    if (needWait) setStatus('loading');
    await waitForVoices(1000);
    state.engine = decideEngine();
    state.sapiUnavailable=false;state.errorMessage='';if(!options.preserveRoute){state.fallbackVoice=null;state.speechRoute='direct';}
    state.index = clamp(state.index, 0, state.paragraphs.length - 1);
    speakCurrent();
  }

  function speakCurrent() {
    const item = state.paragraphs[state.index];
    if (!item) { finishChapter(); return; }
    cancelPlayback();
    const gen = state.gen;
    state.currentText = item.text;
    applyHighlight(item.el);
    setStatus('playing');

    state.engine=decideEngine();
    if (state.engine === 'native') { try{window.AndroidBridge.speak(item.text,state.fallbackVoice?.voiceURI||getSettings().ttsVoice||'',Number(getSettings().ttsRate),gen);}catch(e){failSapi(e.message);} return; }
    if (state.engine === 'sapi') { speakSapi(item.text, gen); return; }

    try {
      const utterance = new SpeechSynthesisUtterance(item.text);
      const voice = pickVoice();
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang || 'zh-CN';
      } else {
        utterance.lang = 'zh-CN';
      }
      utterance.rate = clamp(getSettings().ttsRate, 0.6, 2);
      utterance.pitch = 1;
      utterance.onend = () => {
        if (gen !== state.gen) return;
        advance();
      };
      utterance.onerror = (event) => {
        if (gen !== state.gen) return;
        const err = (event && event.error) || '';
        if (err === 'interrupted' || err === 'canceled' || err === 'cancelled') return;
        handleBrowserSpeechFailure(err);
      };
      synth.speak(utterance);
    } catch (err) {
      handleBrowserSpeechFailure(err && err.message ? err.message : '未知错误');
    }
  }

  function handleBrowserSpeechFailure(message) {
    if (state.sapiUnavailable) { failSapi(message); return; }
    state.engine = 'sapi';
    toast('浏览器语音不可用，已切换系统语音', 'info');
    speakCurrent();
  }

  async function speakSapi(text, gen) {
    if (!audio) { failSapi('当前环境不支持音频播放'); return; }
    const clipped = text.length > 2500 ? text.slice(0, 2500) : text;
    const controller=new AbortController();state.ttsAbort=controller;const timeout=setTimeout(()=>controller.abort(),55000);
    setStatus('loading');
    try {
      const voice=getSettings().ttsVoice||'';
      const options={method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json; charset=utf-8'},body:JSON.stringify({text:clipped,voice,rate:clamp(getSettings().ttsRate,0.6,2)})};
      async function requestAudio(remote=false){
        const response=remote?await window.stellaRemote('/tts',{...options,timeoutMs:8000}):await fetch('/api/tts',options);
        if(!response.ok){let message='语音连接失败';try{message=(await response.json()).error?.message||message;}catch{}throw new Error(message);}
        const result=await response.blob();if(!result||result.size<44)throw new Error('语音返回了空音频');return result;
      }
      let blob;
      try{
        const useDesktop=!!window.AndroidBridge&&(/^(pc|azure|openai):/.test(voice)||state.speechRoute==='desktop');
        blob=await requestAudio(useDesktop);
      }catch(error){
        if(gen!==state.gen||controller.signal.aborted)throw error;
        if(window.AndroidBridge&&voice.startsWith('edge:')&&state.speechRoute!=='desktop'&&window.stellaRemote){
          try{blob=await requestAudio(true);if(gen!==state.gen||controller.signal.aborted)return;state.speechRoute='desktop';toast('已通过配对电脑中转当前音色','info');}catch{}
        }
        if(!blob)throw error;
      }
      if(gen!==state.gen)return;
      revokeAudioUrl();
      const url = URL.createObjectURL(blob);
      state.audioUrl = url;
      audio.src = url;
      audio.onended = () => {
        if (gen !== state.gen) return;
        revokeAudioUrl();
        advance();
      };
      audio.onerror = () => {
        if (gen !== state.gen) return;
        failSapi('音频播放失败');
      };
      await audio.play();
      if (gen !== state.gen) { try { audio.pause(); } catch { /* ignore */ } return; }
      setStatus('playing');
    } catch (err) {
      if (gen !== state.gen) return;
      if(window.AndroidBridge&&!controller.signal.aborted){
        const selected=state.voices.find(v=>v.voiceURI===getSettings().ttsVoice);
        const family=(selected?.lang||'zh').split(/[-_]/)[0].toLowerCase();
        const offline=state.voices.find(v=>v.voiceURI.startsWith('native:')&&v.networkRequired===false&&String(v.lang).toLowerCase().split(/[-_]/)[0]===family);
        if(offline){state.fallbackVoice=offline;state.speechRoute='native';state.sapiUnavailable=false;toast('在线声音暂不可用，已用手机离线声音继续；停止后重新播放可重试在线声音','info',6000);speakCurrent();return;}
      }
      failSapi(controller.signal.aborted?'语音连接超时，请点播放重试':(err?.message||'连接失败，请点播放重试'));
    }finally{clearTimeout(timeout);if(state.ttsAbort===controller)state.ttsAbort=null;}
  }

  function failSapi(message) {
    state.sapiUnavailable = true;
    state.errorMessage=message;
    state.advancing = false;
    cancelPlayback();
    clearHighlight();
    setStatus('idle');
    toast(`朗读失败：${message}`, 'error', 5200);
    emit();
  }

  function pause() {
    if(state.status==='loading'){cancelPlayback();setStatus('paused');return;}
    if (state.status !== 'playing') return;
    if(state.engine==='native'){ state.gen+=1;window.AndroidBridge.stopSpeech();setStatus('paused');return; }
    if (state.engine === 'sapi') {
      try { if (audio) audio.pause(); } catch { /* ignore */ }
    } else if (synth) {
      try { synth.pause(); } catch { /* ignore */ }
    }
    setStatus('paused');
  }

  function resume() {
    if (state.status !== 'paused') return;
    if(state.engine==='native'){speakCurrent();return;}
    if (state.engine === 'sapi') {
      if (!audio || !audio.src) { speakCurrent(); return; }
      audio.play().then(() => setStatus('playing')).catch(() => { setStatus('paused'); });
      return;
    }
    if (synth) {
      if (synth.paused) {
        try { synth.resume(); setStatus('playing'); return; } catch { /* ignore */ }
      }
      // 某些浏览器 pause/resume 会丢状态，直接重读当前段
      speakCurrent();
    }
  }

  function stop(options = {}) {
    state.advancing = false;
    cancelPlayback();
    clearHighlight();
    setStatus('idle');
    if (!options.silent) emit();
  }

  function toggle() {
    openPanel();
    if (state.status === 'playing') pause();
    else if (state.status === 'paused') resume();
    else if (state.status === 'loading') pause();
    else start();
  }

  function advance() {
    if (state.index + 1 < state.paragraphs.length) {
      state.index += 1;
      speakCurrent();
    } else {
      finishChapter();
    }
  }

  async function finishChapter() {
    if (state.advancing) return;
    if (!getSettings().ttsAutoNext) {
      stop({ silent: true });
      toast('本章已读完', 'info');
      return;
    }
    state.advancing = true;
    setStatus('loading');
    let ok = false;
    try {
      ok = await (typeof deps.onChapterEnd === 'function' ? deps.onChapterEnd() : Promise.resolve(false));
    } catch (err) {
      console.error('[tts chapter end]', err);
      ok = false;
    }
    if (!state.advancing) return; // 加载期间用户点了停止
    state.advancing = false;
    if (!ok) {
      stop({ silent: true });
      toast('已经是最后一章了', 'info');
      return;
    }
    // 新章节已由阅读器 setChapter 写入；若尚未开始播放，则从第一段开始
    if (state.status !== 'playing') {
      state.index = 0;
      speakCurrent();
    }
  }

  function moveTo(index, { autoplay = false } = {}) {
    if (!state.paragraphs.length) return;
    const target = clamp(index, 0, state.paragraphs.length - 1);
    const playing = state.status === 'playing' || autoplay;
    const paused = state.status === 'paused';
    cancelPlayback();
    clearHighlight();
    state.index = target;
    state.currentText = state.paragraphs[state.index].text;
    if (playing) { state.engine = state.engine || decideEngine(); speakCurrent(); }
    else {
      applyHighlight(state.paragraphs[state.index].el);
      setStatus(paused ? 'paused' : 'idle');
    }
  }

  function prevParagraph() {
    if (!state.paragraphs.length) return;
    if (state.status === 'playing' || state.status === 'paused') {
      if (state.index <= 0) return;
      const playing = state.status === 'playing';
      const paused = state.status === 'paused';
      cancelPlayback();
      clearHighlight();
      state.index -= 1;
      state.currentText = state.paragraphs[state.index].text;
      if (playing) speakCurrent();
      else { applyHighlight(state.paragraphs[state.index].el); setStatus(paused ? 'paused' : 'idle'); }
    } else {
      moveTo(state.index - 1);
    }
  }

  function nextParagraph() {
    if (!state.paragraphs.length) return;
    if (state.index + 1 >= state.paragraphs.length) {
      if (getSettings().ttsAutoNext) finishChapter();
      else {
        cancelPlayback();
        clearHighlight();
        setStatus('idle');
        toast('已经是本章最后一段了', 'info');
      }
      return;
    }
    if (state.status === 'playing') {
      cancelPlayback();
      clearHighlight();
      state.index += 1;
      speakCurrent();
    } else {
      const paused = state.status === 'paused';
      cancelPlayback();
      clearHighlight();
      state.index += 1;
      state.currentText = state.paragraphs[state.index].text;
      applyHighlight(state.paragraphs[state.index].el);
      setStatus(paused ? 'paused' : 'idle');
    }
  }

  /* ---------------- 面板 ---------------- */

  function openPanel() {
    if (state.panelOpen) return;
    state.panelOpen = true;
    const el = $('#ttsPanel');
    if (el) { el.classList.add('open'); el.removeAttribute('aria-hidden'); }
    const view = $('#readerView');
    if (view) view.classList.add('tts-open');
    emit();
  }

  function closePanel() {
    if (!state.panelOpen) return;
    state.panelOpen = false;
    const el = $('#ttsPanel');
    if (el) { el.classList.remove('open'); el.setAttribute('aria-hidden', 'true'); }
    const view = $('#readerView');
    if (view) view.classList.remove('tts-open');
    emit();
  }

  function togglePanel() { if (state.panelOpen) closePanel(); else openPanel(); }

  function refreshCurrent() {
    state.sapiUnavailable=false;state.errorMessage='';state.fallbackVoice=null;state.speechRoute='direct';
    if (state.status === 'playing' || state.status==='loading') {
      cancelPlayback();
      speakCurrent();
    } else {
      emit();
    }
  }

  /* ---------------- 设置联动 ---------------- */

  let preferenceTimer;
  function publishVoicePreferences(){if(window.AndroidBridge)return;clearTimeout(preferenceTimer);preferenceTimer=setTimeout(()=>fetch('/api/voice-preferences',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ttsVoice:getSettings().ttsVoice,ttsRate:getSettings().ttsRate})}).catch(()=>{}),250);}
  setTimeout(publishVoicePreferences,500);
  subscribe((settings, prev) => {
    if(!prev || settings.ttsVoice!==prev.ttsVoice || settings.ttsRate!==prev.ttsRate)publishVoicePreferences();
    if (!settings.ttsHighlight && prev && prev.ttsHighlight) clearHighlight();
    emit();
  });

  return {
    // 状态
    getState,
    subscribe: subscribeState,
    isActive: () => state.status === 'playing' || state.status === 'paused' || state.status === 'loading',
    isPlaying: () => state.status === 'playing',
    // 章节
    setChapter,
    // 播放控制
    start, pause, resume, stop, toggle,
    prev: prevParagraph,
    next: nextParagraph,
    // 面板
    openPanel, closePanel, togglePanel, isPanelOpen: () => state.panelOpen,
    // 设置
    refreshCurrent,
    // 音色
    getVoices, onVoicesChanged, isZhVoice,
  };
}

/* ==========================================================================
   朗读 UI 绑定
   ========================================================================== */

export function bindTtsUi(tts) {
  const panel = $('#ttsPanel');
  const playBtn = $('#ttsPlay');
  const prevBtn = $('#ttsPrev');
  const nextBtn = $('#ttsNext');
  const stopBtn = $('#ttsStop');
  const closeBtn = $('#btnCloseTtsPanel');
  const chapterLabel = $('#ttsChapterLabel');
  const paragraphText = $('#ttsParagraphText');
  const progressBar = $('#ttsProgressBar');
  const rateInput = $('#ttsRate');
  const rateValue = $('#ttsRateValue');
  const voiceSelect = $('#ttsVoice');
  const statusEl = $('#ttsStatus');
  const toolbarBtn = $('#btnTts');
  const miniBtn = $('#btnTtsMini');
  const miniText = $('#ttsMiniText');

  const ENGINE_LABEL = { browser: '浏览器语音', sapi: '在线 / 系统语音', native:'安卓系统语音' };

  function renderVoices(voices) {
    const current = getSettings().ttsVoice;
    const zh = voices.filter((voice) => tts.isZhVoice(voice));
    const others = voices.filter((voice) => !tts.isZhVoice(voice));
    const parts = ['<option value="">自动（中文优先）</option>'];
    if (zh.length) {
      parts.push('<optgroup label="中文语音">');
      zh.forEach((voice) => {
        parts.push(`<option value="${escapeAttr(voice.voiceURI)}">${escapeAttr(window.AndroidBridge&&voice.voiceURI.startsWith('edge:')?voice.name+'（无需电脑）':voice.name)}${voice.lang ? ` · ${escapeAttr(voice.lang)}` : ''}</option>`);
      });
      parts.push('</optgroup>');
    }
    if (others.length) {
      parts.push('<optgroup label="其他语音">');
      others.forEach((voice) => {
        parts.push(`<option value="${escapeAttr(voice.voiceURI)}">${escapeAttr(voice.name)}${voice.lang ? ` · ${escapeAttr(voice.lang)}` : ''}</option>`);
      });
      parts.push('</optgroup>');
    }
    if (!voices.length) {
      parts.push('<option value="" disabled>未检测到浏览器语音，将使用系统语音</option>');
    }
    voiceSelect.innerHTML = parts.join('');
    if (Array.from(voiceSelect.options).some((opt) => opt.value === current)) voiceSelect.value = current;
    else voiceSelect.value = '';
  }

  function escapeAttr(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function render(state) {
    const playing = state.status === 'playing';
    const paused = state.status === 'paused';
    const loading = state.status === 'loading';
    const active = playing || paused || loading;

    panel.classList.toggle('is-playing', playing);
    panel.classList.toggle('is-paused', paused);
    toolbarBtn.classList.toggle('active', active);
    playBtn.innerHTML = icon(playing || loading ? 'pause' : 'play', 23);
    playBtn.setAttribute('aria-label', playing ? '暂停' : paused ? '继续' : '开始朗读');

    const chapterTitle = state.chapter && state.chapter.title ? state.chapter.title : '尚未开始';
    chapterLabel.textContent = state.chapter && state.chapter.total
      ? `${chapterTitle} · 第 ${state.chapter.index + 1}/${state.chapter.total} 章`
      : chapterTitle;
    paragraphText.textContent = state.text || '点击下方播放按钮，从本章开始逐段朗读。';
    const ratio = state.total ? ((state.index + 1) / state.total) * 100 : 0;
    progressBar.style.width = `${clamp(ratio, 0, 100)}%`;

    statusEl.classList.toggle('is-error', !!state.sapiUnavailable);
    if (state.sapiUnavailable) {
      statusEl.textContent = (state.errorMessage||'所选声音暂不可用')+' · 点播放可重试';
    } else if (loading) {
      statusEl.textContent = state.advancing ? '正在载入下一章…' : '正在准备语音…';
    } else if (playing) {
      statusEl.textContent = `正在朗读 · 第 ${state.index + 1}/${state.total} 段 · ${state.fallbackVoice?'手机离线声音（临时接替）':state.speechRoute==='desktop'?'电脑中转':ENGINE_LABEL[state.engine] || ''}`;
    } else if (paused) {
      statusEl.textContent = `已暂停 · 第 ${state.index + 1}/${state.total} 段`;
    } else if (state.total) {
      statusEl.textContent = `准备就绪 · 本章共 ${state.total} 段 · ${ENGINE_LABEL[state.engine] || ''}`;
    } else {
      statusEl.textContent = '准备就绪';
    }

    if (active) {
      miniBtn.hidden = false;
      miniText.textContent = playing
        ? `朗读中 · ${state.index + 1}/${Math.max(state.total, 1)} 段`
        : paused ? '朗读已暂停' : '正在载入下一章…';
    } else {
      miniBtn.hidden = true;
    }

    // 同步两处语速/音色控件
    if (rateInput) rateInput.value = getSettings().ttsRate;
    if (rateValue) rateValue.textContent = `${Number(getSettings().ttsRate).toFixed(2).replace(/0$/, '')}×`;
    if (voiceSelect && getSettings().ttsVoice !== voiceSelect.value) {
      const exists = Array.from(voiceSelect.options).some((opt) => opt.value === getSettings().ttsVoice);
      voiceSelect.value = exists ? getSettings().ttsVoice : '';
    }
  }

  tts.subscribe(render);
  tts.onVoicesChanged(renderVoices);

  playBtn.addEventListener('click', () => {
    const status = tts.getState().status;
    if (status === 'playing' || status === 'loading') tts.pause();
    else if (status === 'paused') tts.resume();
    else tts.start();
  });
  prevBtn.addEventListener('click', () => tts.prev());
  nextBtn.addEventListener('click', () => tts.next());
  stopBtn.addEventListener('click', () => tts.stop());
  closeBtn.addEventListener('click', () => tts.closePanel());
  toolbarBtn.addEventListener('click', () => tts.toggle());
  miniBtn.addEventListener('click', () => tts.openPanel());

  rateInput.addEventListener('input', () => {
    const value = clamp(rateInput.value, 0.6, 2);
    rateValue.textContent = `${Number(value).toFixed(2).replace(/0$/, '')}×`;
    updateSettings({ ttsRate: value });
  });
  rateInput.addEventListener('change', () => tts.refreshCurrent());

  voiceSelect.addEventListener('change', () => {
    updateSettings({ ttsVoice: voiceSelect.value });
    tts.refreshCurrent();
  });

  // 初始化控件值
  rateInput.value = getSettings().ttsRate;
  rateValue.textContent = `${Number(getSettings().ttsRate).toFixed(2).replace(/0$/, '')}×`;
  render(tts.getState());
}
