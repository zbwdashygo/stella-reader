'use strict';
/**
 * 桌面端（Electron）真实进程验收：连 CDP，检查 preload API、语音、拖拽导入、阅读、朗读。
 * 用法：先带 --remote-debugging-port=9333 启动应用，再 node shell/desktop-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SHOTS = path.join(__dirname, '..', 'test', 'shots');
const FIXTURE = path.join(__dirname, '..', 'test', 'fixtures', '中文样例.epub');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(ok, label, detail) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? '  —  ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9333', defaultViewport: null });
  const pages = await browser.pages();
  const page = pages.find((p) => p.url().includes('127.0.0.1')) || pages[0];
  log(!!page, '连接 Electron 窗口', page && page.url());

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await sleep(1200);
  const info = await page.evaluate(async () => {
    const shell = window.epubShell || null;
    const api = shell ? Object.keys(shell) : [];
    let voices = [];
    for (let i = 0; i < 10; i++) {
      voices = speechSynthesis.getVoices().map((v) => `${v.name}|${v.lang}`);
      if (voices.length) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    return {
      title: document.title,
      shellIsElectron: !!(shell && shell.isElectron),
      shellApi: api,
      voiceCount: voices.length,
      zhVoices: voices.filter((v) => v.includes('zh')).slice(0, 5),
      theme: document.documentElement.dataset.theme,
      hasImportBtn: !!document.getElementById('btnImport'),
      libraryCount: document.getElementById('libraryCount') && document.getElementById('libraryCount').textContent,
    };
  });
  log(info.shellIsElectron, 'preload 暴露 epubShell', info.shellApi.join(','));
  log(info.hasImportBtn, '首屏渲染（导入按钮存在）', 'title=' + info.title + ' 主题=' + info.theme);
  console.log(`    Electron 语音数：${info.voiceCount}，中文语音：${info.zhVoices.join(' / ') || '无'}`);
  await page.screenshot({ path: path.join(SHOTS, 'electron-01-library-empty.png') });

  // 拖拽导入（模拟真实 File；Electron 里 getFilePath 拿不到路径 → 走 import-bytes 兜底）
  const b64 = fs.readFileSync(FIXTURE).toString('base64');
  const dropped = await page.evaluate(async (base64) => {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], '中文样例.epub', { type: 'application/epub+zip' });
    const dt = new DataTransfer();
    dt.items.add(file);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      window.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
    return { fileSize: file.size };
  }, b64);
  log(dropped.fileSize > 0, '模拟拖拽 File', dropped.fileSize + ' bytes');

  let cardCount = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    cardCount = await page.evaluate(() => document.querySelectorAll('#bookGrid .book-card').length);
    if (cardCount > 0) break;
  }
  log(cardCount > 0, '拖拽后书库出现卡片', cardCount + ' 张');
  await page.screenshot({ path: path.join(SHOTS, 'electron-02-library.png') });

  if (cardCount > 0) {
    await page.click('#bookGrid .book-card');
    await sleep(1500);
    const reader = await page.evaluate(() => {
      const frame = document.getElementById('readerFrame') || document.querySelector('iframe');
      const doc = frame && frame.contentDocument;
      return {
        readerVisible: !document.getElementById('readerView').hidden,
        iframeSrc: frame ? frame.getAttribute('src') : null,
        chars: doc && doc.body ? doc.body.innerText.trim().length : 0,
        chapterLabel: (document.getElementById('chapterIndicator') || {}).textContent,
      };
    });
    log(reader.readerVisible && reader.chars > 100, '打开阅读器且 iframe 有正文', `${reader.chars} 字 ${reader.chapterLabel || ''}`);
    await page.screenshot({ path: path.join(SHOTS, 'electron-03-reader.png') });

    // 朗读
    await page.evaluate(() => {
      const btn = document.getElementById('btnSpeak') || document.getElementById('btnTts') || document.querySelector('[data-tts-toggle]');
      if (btn) btn.click();
    });
    await sleep(2500);
    const tts = await page.evaluate(() => {
      const frame = document.querySelector('iframe');
      const doc = frame && frame.contentDocument;
      return {
        speaking: typeof speechSynthesis !== 'undefined' && speechSynthesis.speaking,
        highlighted: doc ? doc.querySelectorAll('.tts-current').length : 0,
        status: (document.getElementById('ttsStatus') || {}).textContent,
        panelOpen: !!document.querySelector('.tts-panel:not([hidden]), #ttsPanel:not([hidden])'),
      };
    });
    log(tts.speaking && tts.highlighted > 0, '朗读启动并高亮当前段落', `speaking=${tts.speaking} 高亮=${tts.highlighted} ${tts.status || ''}`);
    await page.screenshot({ path: path.join(SHOTS, 'electron-04-tts.png') });

    // 切到夜间主题
    const themed = await page.evaluate(() => {
      const btn = document.getElementById('btnThemeToggle') || document.querySelector('[data-theme-toggle]');
      if (btn) btn.click();
      return document.documentElement.dataset.theme;
    });
    await sleep(600);
    log(!!themed, '切换主题', String(themed));
    await page.screenshot({ path: path.join(SHOTS, 'electron-05-theme.png') });
  }

  if (errors.length) {
    console.log('  控制台错误：');
    errors.slice(0, 8).forEach((e) => console.log('   - ' + e));
  } else {
    console.log('  ✓ 无控制台错误');
  }
  console.log(process.exitCode ? '结果：FAIL' : '结果：PASS');
  browser.disconnect();
})().catch((err) => { console.error('验收脚本异常：', err); process.exit(1); });
