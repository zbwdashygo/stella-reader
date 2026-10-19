/* 阅读设置：localStorage 持久化 + 主题/排版变量 */

import { store, clamp, prefersDark } from './util.js';

export const SETTINGS_KEY = 'tingshu:settings:v1';

export const DEFAULT_SETTINGS = Object.freeze({
  readingMode: 'paged', // paged | scroll
  theme: 'day',        // day | night | sepia | system
  font: 'serif',       // serif | hei | kai | system
  fontSize: 18,        // px 14-28
  lineHeight: 1.8,     // 1.4-2.2
  pageWidth: 720,      // px 560-960
  paragraphSpacing: 0.6, // em
  ttsVoice: '',        // voiceURI，空=自动（中文优先）
  ttsRate: 1,          // 0.6-2.0
  ttsAutoNext: true,
  ttsHighlight: true,
});

export const THEMES = [
  { id: 'day', label: '日间', icon: 'sun' },
  { id: 'night', label: '夜间', icon: 'moon' },
  { id: 'sepia', label: '护眼', icon: 'leaf' },
  { id: 'system', label: '跟随系统', icon: 'monitor' },
];

export const FONTS = [
  { id: 'serif', label: '宋体（衬线）', stack: '"Songti SC", "SimSun", "Noto Serif SC", "Source Han Serif SC", serif' },
  { id: 'hei', label: '黑体（无衬线）', stack: '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", "Source Han Sans SC", sans-serif' },
  { id: 'kai', label: '楷体', stack: '"KaiTi", "Kaiti SC", "STKaiti", "Noto Serif SC", serif' },
  { id: 'system', label: '系统默认', stack: '"Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif' },
];

export const READER_PALETTES = {
  day: {
    bg: '#fbf8f1', text: '#2b2f2a', muted: '#6e7a70', link: '#2f6f5e',
    border: 'rgba(47,111,94,0.18)', accent: '#c9a227', accentSoft: 'rgba(201,162,39,0.28)',
    selection: 'rgba(201,162,39,0.30)', codeBg: 'rgba(47,111,94,0.06)',
  },
  night: {
    bg: '#191e20', text: '#d7dcd4', muted: '#93a097', link: '#8fd2ba',
    border: 'rgba(255,255,255,0.13)', accent: '#d8b84a', accentSoft: 'rgba(216,184,74,0.32)',
    selection: 'rgba(216,184,74,0.30)', codeBg: 'rgba(255,255,255,0.07)',
  },
  sepia: {
    bg: '#f4ead4', text: '#423725', muted: '#8a7a5c', link: '#3f6b52',
    border: 'rgba(90,70,40,0.20)', accent: '#b98a2f', accentSoft: 'rgba(185,138,47,0.30)',
    selection: 'rgba(185,138,47,0.28)', codeBg: 'rgba(120,90,40,0.07)',
  },
};

function sanitize(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  const out = { ...merged };
  if(!['paged','scroll'].includes(out.readingMode))out.readingMode='paged';
  if (!THEMES.some((t) => t.id === out.theme)) out.theme = DEFAULT_SETTINGS.theme;
  if (!FONTS.some((f) => f.id === out.font)) out.font = DEFAULT_SETTINGS.font;
  out.fontSize = Math.round(clamp(out.fontSize, 14, 28));
  out.lineHeight = Math.round(clamp(out.lineHeight, 1.4, 2.2) * 100) / 100;
  out.pageWidth = Math.round(clamp(out.pageWidth, 560, 960) / 10) * 10;
  out.paragraphSpacing = Math.round(clamp(out.paragraphSpacing, 0, 1.5) * 10) / 10;
  out.ttsRate = Math.round(clamp(out.ttsRate, 0.6, 2) * 100) / 100;
  out.ttsVoice = typeof out.ttsVoice === 'string' ? out.ttsVoice : '';
  out.ttsAutoNext = !!out.ttsAutoNext;
  out.ttsHighlight = !!out.ttsHighlight;
  return out;
}

let state = sanitize(store.get(SETTINGS_KEY, {}));
const listeners = new Set();
let mediaQuery = null;

export function getSettings() {
  return state;
}

export function resolvedTheme() {
  return state.theme === 'system' ? (prefersDark() ? 'night' : 'day') : state.theme;
}

export function getReaderPalette() {
  return READER_PALETTES[resolvedTheme()] || READER_PALETTES.day;
}

export function fontStack(fontId = state.font) {
  const found = FONTS.find((f) => f.id === fontId);
  return (found || FONTS[0]).stack;
}

export function updateSettings(patch) {
  const prev = state;
  const next = sanitize({ ...state, ...patch });
  const changed = Object.keys(next).some((key) => next[key] !== prev[key]);
  if (!changed) return state;
  state = next;
  store.set(SETTINGS_KEY, state);
  applyShell();
  listeners.forEach((fn) => { try { fn(state, prev); } catch (err) { console.error('[settings listener]', err); } });
  return state;
}

export function resetSettings() {
  const prev = state;
  state = { ...DEFAULT_SETTINGS };
  store.set(SETTINGS_KEY, state);
  applyShell();
  listeners.forEach((fn) => { try { fn(state, prev); } catch (err) { console.error('[settings listener]', err); } });
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function applyShell() {
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme();
  root.dataset.themeChoice = state.theme;
  root.dataset.font = state.font;
  root.dataset.readingMode = state.readingMode;
  root.style.setProperty('--page-width', `${state.pageWidth}px`);
}

export function initSettings() {
  applyShell();
  if (window.matchMedia) {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (state.theme !== 'system') return;
      const prev = state;
      applyShell();
      listeners.forEach((fn) => { try { fn(state, prev); } catch (err) { console.error(err); } });
    };
    if (mediaQuery.addEventListener) mediaQuery.addEventListener('change', onChange);
    else if (mediaQuery.addListener) mediaQuery.addListener(onChange);
  }
}
