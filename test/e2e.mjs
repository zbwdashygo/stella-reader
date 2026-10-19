#!/usr/bin/env node
/**
 * test/e2e.mjs —— 听书 · EPUB 播放器 端到端测试
 *
 * 流程：
 *  1. spawn `node server/index.js`（PORT=0，DATA_DIR=test/.e2e-data），解析 stdout `LISTENING <port>`
 *  2. 接口契约测试（health/import/books/spine/toc/res/cover/search/patch/403/404/损坏文件/重复导入/import-bytes/start 导出）
 *  3. puppeteer-core + Edge 驱动 UI：空书库 → API 导入两本样例 → 刷新 → 打开书 → 目录切章 → 搜索
 *     → 进度保存/刷新恢复 → 设置面板/夜间主题 → 朗读高亮 → 英文书 → 清理删除
 *  4. 截图 test/shots/*.png（1920x1080），任何 FAIL → exit 1
 *
 * 用法：
 *   node test/e2e.mjs                      # 全流程（默认 headless）
 *   node test/e2e.mjs --headed             # 显示浏览器（调试）
 *   node test/e2e.mjs --api-only           # 只跑接口契约测试（不需要 web/）
 *   node test/e2e.mjs --keep-data          # 保留 test/.e2e-data
 *
 * 环境变量：
 *   E2E_EDGE      浏览器可执行文件（默认 Edge 安装路径）
 *   E2E_TIMEOUT   单步等待超时 ms（默认 15000）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const SHOTS = path.join(__dirname, 'shots');
const DATA_DIR = process.env.E2E_DATA_DIR || path.join(__dirname, '.e2e-data');
const CN_PATH = path.join(FIXTURES, '中文样例.epub');
const EN_PATH = path.join(FIXTURES, 'english.epub');
const EDGE = process.env.E2E_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const TIMEOUT = Number(process.env.E2E_TIMEOUT || 15000);

const ARGS = process.argv.slice(2);
const HEADED = ARGS.includes('--headed');
const API_ONLY = ARGS.includes('--api-only');
const KEEP_DATA = ARGS.includes('--keep-data');

/* ------------------------------------------------------------------ *
 * 结果记录
 * ------------------------------------------------------------------ */
const R = { pass: [], fail: [], warn: [], shots: [] };

function out(line) {
  process.stdout.write(line + '\n');
}
function pass(name, detail = '') {
  R.pass.push({ name, detail });
  out(`  ✓ ${name}${detail ? `  —  ${detail}` : ''}`);
}
function fail(name, detail = '') {
  R.fail.push({ name, detail });
  out(`  ✗ ${name}${detail ? `  —  ${detail}` : ''}`);
}
function warn(name, detail = '') {
  R.warn.push({ name, detail });
  out(`  ! ${name}${detail ? `  —  ${detail}` : ''}`);
}
async function attempt(name, fn) {
  try {
    const d = await fn();
    pass(name, typeof d === 'string' ? d : d || '');
    return true;
  } catch (e) {
    fail(name, e && e.message ? e.message : String(e));
    await captureFailure();
    return false;
  }
}
async function attemptWarn(name, fn) {
  try {
    const d = await fn();
    pass(name, typeof d === 'string' ? d : d || '');
    return true;
  } catch (e) {
    warn(name, e && e.message ? e.message : String(e));
    await captureFailure();
    return false;
  }
}

async function captureFailure() {
  if (!page) return;
  try {
    const file = path.join(SHOTS, `zz-fail-${R.fail.length}.png`);
    await page.screenshot({ path: file });
    R.shots.push(file);
    out(`  📸 ${path.relative(ROOT, file)}（失败现场）`);
  } catch (_) {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 通用 HTTP
 * ------------------------------------------------------------------ */
let BASE = '';
async function req(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, opts);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {}
  return { res, status: res.status, headers: res.headers, text, json, buf };
}

async function getJson(pathname) {
  return req(pathname);
}
async function postJson(pathname, body) {
  return req(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function patchJson(pathname, body) {
  return req(pathname, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function del(pathname) {
  return req(pathname, { method: 'DELETE' });
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}
function expectEq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function expectStatus(r, expected, label) {
  if (r.status !== expected) {
    const detail = r.json && r.json.error ? ` ${JSON.stringify(r.json.error)}` : ` ${r.text.slice(0, 120)}`;
    throw new Error(`${label}：期望 HTTP ${expected}，实际 ${r.status}${detail}`);
  }
}

/* ------------------------------------------------------------------ *
 * 服务端进程
 * ------------------------------------------------------------------ */
let serverProc = null;
let serverLog = '';

async function startServer() {
  const port = process.env.E2E_PORT || '0';
  serverLog = '';
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: port, DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serverProc = child;
  child.stderr.on('data', (d) => (serverLog += d.toString('utf8')));
  const actualPort = await new Promise((resolve, reject) => {
    let buffer = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`等待 LISTENING 超时（30s）。服务端输出：${buffer.slice(-800)}${serverLog.slice(-800)}`));
    }, 30000);
    child.stdout.on('data', (d) => {
      buffer += d.toString('utf8');
      const m = buffer.match(/LISTENING\s+(\d+)/);
      if (m && !done) {
        done = true;
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on('exit', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`服务进程提前退出（exit ${code}）。stderr：${serverLog.slice(-1200)}`));
    });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
  });
  return { child, port: actualPort };
}

async function stopServer() {
  const child = serverProc;
  if (!child) return;
  serverProc = null;
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch (_) {}
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill();
    } catch (_) {
      clearTimeout(timer);
      resolve();
    }
  });
}

/* ------------------------------------------------------------------ *
 * 接口契约测试
 * ------------------------------------------------------------------ */
const ids = {};

async function checkStartExport() {
  const code = `
    const m = require('./server/index.js');
    if (typeof m.start !== 'function') { console.error('NO_START_EXPORT'); process.exit(2); }
    console.log('START_EXPORT_OK');
    process.exit(0);
  `;
  const child = spawn(process.execPath, ['-e', code], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', DATA_DIR: path.join(DATA_DIR, 'export-check') },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
  child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {}
      resolve({ ok: false, detail: '检查超时（15s）' });
    }, 15000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      const ok = stdout.includes('START_EXPORT_OK');
      resolve({
        ok,
        detail: ok ? 'shell/main.js 可 require 并调用 start({port,dataDir})' : `exit ${code} stdout=${stdout.trim()} stderr=${stderr.trim().slice(0, 300)}`,
      });
    });
  });
  expect(result.ok, result.detail);
  return result.detail;
}

async function apiPhase() {
  out('\n[1/3] 接口契约测试');

  let health = null;
  await attempt('GET /api/health 返回 ok', async () => {
    health = await getJson('/api/health');
    expectStatus(health, 200, 'health');
    expect(health.json && health.json.ok === true, `health json 异常：${health.text.slice(0, 200)}`);
    return `version=${health.json.version || '?'} platform=${health.json.platform || '?'}`;
  });

  await attempt('GET / 返回中文首页', async () => {
    const r = await req('/');
    expectStatus(r, 200, 'GET /');
    expect(/text\/html/.test(r.headers.get('content-type') || ''), `Content-Type 异常：${r.headers.get('content-type')}`);
    expect(r.text.includes('听书') || r.text.includes('epub'), '首页内容不含「听书」');
    return `${r.buf.length} bytes`;
  });

  await attemptWarn('server/index.js 导出 start()（桌面壳依赖）', checkStartExport);

  // ---- 导入 ----
  await attempt('POST /api/books/import 导入中文样例', async () => {
    const r = await postJson('/api/books/import', { path: CN_PATH });
    expectStatus(r, 200, 'import CN');
    const b = r.json && r.json.book;
    expect(b && b.id, `缺少 book：${r.text.slice(0, 200)}`);
    ids.cn = b.id;
    expectEq(b.title, '听书测试样书', '中文书名');
    expectEq(b.author, '测试作者', '中文作者');
    expect(b.spineCount >= 6, `spineCount=${b.spineCount}，期望 ≥6`);
    expect(typeof b.cover === 'string' && b.cover.length > 0, '缺少封面字段');
    expect(/^[0-9a-f]{16}$/i.test(b.id), `id 格式异常：${b.id}`);
    expect(b.language === 'zh' || /^zh/i.test(b.language || ''), `language=${b.language}`);
    return `id=${b.id} spine=${b.spineCount}`;
  });

  await attempt('POST /api/books/import 导入英文真实样例（EPUB2/ncx）', async () => {
    const r = await postJson('/api/books/import', { path: EN_PATH });
    expectStatus(r, 200, 'import EN');
    const b = r.json && r.json.book;
    expect(b && b.id, `缺少 book：${r.text.slice(0, 200)}`);
    ids.en = b.id;
    expectEq(b.title, 'Pride and Prejudice', '英文书名');
    expectEq(b.author, 'Jane Austen', '英文作者');
    expect(b.spineCount >= 10, `spineCount=${b.spineCount}，期望 ≥10`);
    return `id=${b.id} spine=${b.spineCount}`;
  });

  await attempt('GET /api/books 返回 2 本、按最近阅读倒序', async () => {
    const r = await getJson('/api/books');
    expectStatus(r, 200, 'books');
    const list = r.json && r.json.books;
    expect(Array.isArray(list) && list.length === 2, `books.length=${list && list.length}`);
    return list.map((b) => b.title).join(' / ');
  });

  // ---- 详情 / TOC ----
  await attempt('GET /api/books/:id 中文书 spine/toc 完整', async () => {
    const r = await getJson(`/api/books/${ids.cn}`);
    expectStatus(r, 200, 'GET CN book');
    const { book, spine, toc } = r.json || {};
    expect(book && spine && toc, '响应缺少 book/spine/toc');
    expectEq(spine.length, book.spineCount, 'spine 长度');
    expect(spine.every((s) => typeof s.path === 'string' && s.path.length > 0), '存在无 path 的 spine 项');
    expect(spine.length >= 6, `spine 项数 ${spine.length}`);
    // toc 层级
    const depths = [];
    const walk = (items, d) => {
      for (const it of items || []) {
        depths.push(typeof it.depth === 'number' ? it.depth : d);
        if (it.children) walk(it.children, d + 1);
      }
    };
    walk(toc, 0);
    expect(depths.length >= 6, `toc 条目数 ${depths.length}`);
    expect(Math.max(...depths) >= 1, `toc 未解析出两级（max depth=${Math.max(...depths)}）`);
    const flat = [];
    const flatten = (items) => {
      for (const it of items || []) {
        flat.push(it);
        flatten(it.children);
      }
    };
    flatten(toc);
    expect(flat.some((it) => (it.title || '').includes('第三章')), 'toc 缺少「第三章」');
    expect(flat.every((it) => typeof it.title === 'string' && it.title.length), 'toc 存在空标题');
    ids.cnSpine = spine;
    ids.cnToc = toc;
    return `${spine.length} 章 / toc ${flat.length} 条 / maxDepth=${Math.max(...depths)}`;
  });

  await attempt('GET /api/books/:id 英文书 toc（ncx）完整', async () => {
    const r = await getJson(`/api/books/${ids.en}`);
    expectStatus(r, 200, 'GET EN book');
    const { spine, toc } = r.json || {};
    expect(Array.isArray(spine) && spine.length >= 10, `spine=${spine && spine.length}`);
    expect(Array.isArray(toc) && toc.length >= 1, `toc=${toc && toc.length}`);
    const flat = [];
    const flatten = (items) => {
      for (const it of items || []) {
        flat.push(it);
        flatten(it.children);
      }
    };
    flatten(toc);
    expect(flat.length >= 5, `ncx 解析条目 ${flat.length}，期望 ≥5`);
    return `${spine.length} 章 / ncx ${flat.length} 条`;
  });

  // ---- 资源 ----
  const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
  let firstPath = '';
  await attempt('GET /res/<spine[0]> 返回 xhtml 且中文正常', async () => {
    expect(ids.cnSpine && ids.cnSpine[0], '缺少 spine 数据');
    firstPath = ids.cnSpine[0].path;
    const r = await req(`/api/books/${ids.cn}/res/${encPath(firstPath)}`);
    expectStatus(r, 200, 'res ch1');
    const ct = r.headers.get('content-type') || '';
    expect(/application\/xhtml\+xml|text\/html/.test(ct), `Content-Type=${ct}`);
    expect(/charset=utf-8/i.test(ct), `未声明 UTF-8：${ct}`);
    expect(r.text.includes('听书'), '正文不含「听书」');
    expect(!r.text.includes('\uFFFD'), '正文出现 U+FFFD 乱码');
    expect(r.headers.get('x-content-type-options') === 'nosniff', '缺少 X-Content-Type-Options: nosniff');
    const csp = r.headers.get('content-security-policy') || '';
    expect(/default-src/.test(csp), '缺少 CSP 响应头');
    return `${firstPath} (${r.buf.length} bytes)`;
  });

  await attempt('GET /res 章节内插图返回 image/png', async () => {
    const r = await req(`/api/books/${ids.cn}/res/${encPath('OEBPS/images/illustration.png')}`);
    expectStatus(r, 200, 'res illustration');
    expect(/image\/png/.test(r.headers.get('content-type') || ''), `Content-Type=${r.headers.get('content-type')}`);
    expect(r.buf.length > 1000, `图片过小 ${r.buf.length} bytes`);
    return `${r.buf.length} bytes`;
  });

  await attempt('GET /res CSS 返回 text/css', async () => {
    const r = await req(`/api/books/${ids.cn}/res/${encPath('OEBPS/style.css')}`);
    expectStatus(r, 200, 'res css');
    expect(/text\/css/.test(r.headers.get('content-type') || ''), `Content-Type=${r.headers.get('content-type')}`);
    return 'ok';
  });

  await attempt('GET /api/books/:id/cover 中文封面 PNG', async () => {
    const r = await req(`/api/books/${ids.cn}/cover`);
    expectStatus(r, 200, 'cover CN');
    expect(/image\/png/.test(r.headers.get('content-type') || ''), `Content-Type=${r.headers.get('content-type')}`);
    expect(r.buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), '封面不是 PNG');
    return `${r.buf.length} bytes`;
  });

  await attempt('GET /api/books/:id/cover 英文封面 JPEG', async () => {
    const r = await req(`/api/books/${ids.en}/cover`);
    expectStatus(r, 200, 'cover EN');
    expect(/image\/jpeg|image\/png/.test(r.headers.get('content-type') || ''), `Content-Type=${r.headers.get('content-type')}`);
    return `${r.headers.get('content-type')}`;
  });

  // ---- 搜索 ----
  await attempt('GET /search?q=听书 命中并含 <mark>', async () => {
    const r = await getJson(`/api/books/${ids.cn}/search?q=${encodeURIComponent('听书')}`);
    expectStatus(r, 200, 'search');
    const list = r.json && r.json.results;
    expect(Array.isArray(list) && list.length >= 2, `结果数 ${list && list.length}，期望 ≥2`);
    expect(list.every((x) => Number.isInteger(x.spineIndex) && x.spineIndex >= 0), '结果 spineIndex 非法');
    expect(list.some((x) => (x.snippet || '').includes('<mark>听书</mark>')), 'snippet 未用 <mark> 包裹关键词');
    expect(list.every((x) => x.path && x.chapterTitle), '结果缺少 path/chapterTitle');
    expect(list.every((x) => !/<(?!\/?mark\b)[a-z!/]/i.test(x.snippet || '')), 'snippet 含未去除的 HTML 标签');
    ids.searchHits = list.length;
    return `${list.length} 条，首个：第 ${list[0].spineIndex + 1} 章`;
  });

  await attempt('GET /search 无结果返回空数组', async () => {
    const r = await getJson(`/api/books/${ids.cn}/search?q=${encodeURIComponent('ZZZ不存在的关键词9x')}`);
    expectStatus(r, 200, 'search empty');
    expectEq((r.json.results || []).length, 0, '无结果搜索');
    return 'ok';
  });

  // ---- 进度 PATCH / 持久化 ----
  await attempt('PATCH 进度（第五章）并持久化', async () => {
    const payload = { progress: { spineIndex: 4, scrollRatio: 0.25, percent: 0.72, chapterTitle: '第五章 长文练习' } };
    const r = await patchJson(`/api/books/${ids.cn}`, payload);
    expectStatus(r, 200, 'PATCH');
    expect(r.json && r.json.ok === true, 'PATCH 未返回 ok:true');
    const g = await getJson(`/api/books/${ids.cn}`);
    expectStatus(g, 200, 'GET after PATCH');
    const p = g.json.book.progress || {};
    expectEq(p.spineIndex, 4, '持久化 spineIndex');
    expectEq(p.chapterTitle, '第五章 长文练习', '持久化 chapterTitle');
    const list = await getJson('/api/books');
    expectEq(list.json.books[0].id, ids.cn, '最近阅读排序（PATCH 后中文书应在首位）');
    return 'spineIndex=4 percent=0.72，列表首位已更新';
  });

  await attempt('重复导入同一文件：id 不变、进度保留', async () => {
    const r = await postJson('/api/books/import', { path: CN_PATH });
    expectStatus(r, 200, 're-import');
    expectEq(r.json.book.id, ids.cn, '重复导入 id');
    const list = await getJson('/api/books');
    expectEq(list.json.books.length, 2, '重复导入后书数');
    const g = await getJson(`/api/books/${ids.cn}`);
    expectEq(g.json.book.progress.spineIndex, 4, '重复导入后进度');
    return 'id 不变，进度保留';
  });

  // ---- 错误路径 ----
  await attempt('路径越界 /res/../ → 403', async () => {
    const r = await req(`/api/books/${ids.cn}/res/..%2F..%2Fpackage.json`);
    expectStatus(r, 403, 'traversal');
    return '403';
  });

  await attempt('未知 book id → 404', async () => {
    const r = await getJson('/api/books/0000000000000000');
    expectStatus(r, 404, 'unknown book');
    expect(r.json && r.json.error && r.json.error.message, '404 缺少中文 message');
    return r.json.error.message;
  });

  await attempt('未知资源路径 → 404', async () => {
    const r = await req(`/api/books/${ids.cn}/res/${encPath('OEBPS/text/nope.xhtml')}`);
    expectStatus(r, 404, 'unknown res');
    return '404';
  });

  await attempt('导入不存在路径 → 400 + 中文错误', async () => {
    const r = await postJson('/api/books/import', { path: path.join(FIXTURES, '不存在的书.epub') });
    expectStatus(r, 400, 'missing path');
    expect(r.json && r.json.error && /[\u4e00-\u9fa5]/.test(r.json.error.message || ''), `message 非中文：${r.text.slice(0, 200)}`);
    return r.json.error.message;
  });

  await attempt('导入损坏 EPUB → 400 + 中文错误', async () => {
    const broken = path.join(DATA_DIR, 'broken-book.epub');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(broken, Buffer.from('this is definitely not a zip file'));
    try {
      const r = await postJson('/api/books/import', { path: broken });
      expectStatus(r, 400, 'broken epub');
      expect(r.json && r.json.error && /[\u4e00-\u9fa5]/.test(r.json.error.message || ''), `message 非中文：${r.text.slice(0, 200)}`);
      return r.json.error.message;
    } finally {
      fs.rmSync(broken, { force: true });
    }
  });

  await attemptWarn('POST /api/books/import-bytes（拖拽/文件选择兜底）', async () => {
    const dataBase64 = fs.readFileSync(CN_PATH).toString('base64');
    const r = await postJson('/api/books/import-bytes', { name: 'e2e-import-bytes.epub', dataBase64 });
    if (r.status === 404) throw new Error('接口未实现（404）——前端拖拽/文件选择需依赖桌面壳路径或 <input type=file> 降级');
    expectStatus(r, 200, 'import-bytes');
    const b = r.json && r.json.book;
    expect(b && b.id, '缺少 book');
    const d = await del(`/api/books/${b.id}`);
    expectStatus(d, 200, 'delete import-bytes book');
    return `id=${b.id}（已清理）`;
  });

  // 保留数据供 UI 阶段使用
}

/* ------------------------------------------------------------------ *
 * 浏览器 UI 阶段
 * ------------------------------------------------------------------ */
let browser = null;
let page = null;
const ui = { consoleErrors: [], pageErrors: [], failedRequests: [], httpErrors: [], cleanup: false };

const TTS_MOCK = () => {
  const voices = [{ name: 'Microsoft Xiaoxiao (Mock)', lang: 'zh-CN', localService: true, default: true, voiceURI: 'mock-zh-CN' }];
  class MockUtterance {
    constructor(text) {
      this.text = String(text == null ? '' : text);
      this.lang = 'zh-CN';
      this.rate = 1;
      this.pitch = 1;
      this.volume = 1;
      this.voice = null;
      this.onstart = null;
      this.onend = null;
      this.onerror = null;
      this.onboundary = null;
      this.onpause = null;
      this.onresume = null;
    }
  }
  const timers = new Set();
  const synth = {
    speaking: false,
    pending: false,
    paused: false,
    current: null,
    getVoices() {
      return voices.slice();
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
    speak(u) {
      this.speaking = true;
      this.paused = false;
      this.current = u;
      setTimeout(() => {
        try {
          u.onstart && u.onstart({});
        } catch (_) {}
      }, 20);
      const t = setTimeout(() => {
        this.speaking = false;
        try {
          u.onend && u.onend({});
        } catch (_) {
          try {
            u.onerror && u.onerror({ error: 'interrupted' });
          } catch (_) {}
        }
      }, 30000);
      timers.add(t);
    },
    cancel() {
      this.speaking = false;
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
    pause() {
      this.paused = true;
    },
    resume() {
      this.paused = false;
    },
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true, writable: true });
  window.SpeechSynthesisUtterance = MockUtterance;
};

async function launchBrowser() {
  if (!fs.existsSync(EDGE)) throw new Error(`找不到 Edge：${EDGE}（可用 E2E_EDGE 指定）`);
  const puppeteer = (await import('puppeteer-core')).default;
  browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: HEADED ? false : 'new',
    defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
      '--lang=zh-CN',
      '--font-render-hinting=none',
      '--force-device-scale-factor=1',
    ],
  });
  page = await browser.newPage();
  page.setDefaultTimeout(TIMEOUT);
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    // 清理阶段删除书籍后，页面上残留的封面/图片懒加载可能 404，属测试收尾竞态，不计入
    if (ui.cleanup && /404/.test(msg.text())) return;
    ui.consoleErrors.push(msg.text().slice(0, 500));
  });
  page.on('pageerror', (e) => ui.pageErrors.push(String(e && e.message ? e.message : e).slice(0, 500)));
  page.on('response', (res) => {
    const status = res.status();
    if (status < 400) return;
    // 清理阶段删除书籍后仍在途的封面请求可能 404，属测试收尾竞态，不计入
    if (ui.cleanup && status === 404 && /\/cover(\?|$)/.test(res.url())) return;
    ui.httpErrors.push(`${status} ${res.url().slice(0, 200)}`);
  });
  page.on('requestfailed', (r) => {
    const url = r.url();
    if (/favicon/.test(url)) return;
    ui.failedRequests.push(`${r.failure() && r.failure().errorText} ${url.slice(0, 200)}`);
  });
  await page.evaluateOnNewDocument(TTS_MOCK);
}

async function shot(name) {
  const file = path.join(SHOTS, name.endsWith('.png') ? name : name + '.png');
  await page.screenshot({ path: file, type: 'png' });
  R.shots.push(file);
  out(`  📸 ${path.relative(ROOT, file)}`);
}

function normText(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

/** 等待顶层页面 innerText 匹配 */
async function waitPageText(pattern, timeout = TIMEOUT) {
  const src = pattern instanceof RegExp ? pattern.source : String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page.waitForFunction(
    (s) => {
      try {
        return new RegExp(s).test(document.body ? document.body.innerText : '');
      } catch (_) {
        return false;
      }
    },
    { timeout },
    src
  );
}

async function pageText() {
  return page.evaluate(() => (document.body ? document.body.innerText : ''));
}

/** 在顶层页面按可见文本点击（优先级：更小/更深的元素；可选限定选择器） */
async function clickText(text, { timeout = 8000, selectors = null, scope = null } = {}) {
  const ok = await page.waitForFunction(
    ({ text, selectors, scope }) => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const root = scope ? document.querySelector(scope) : document;
      if (!root) return false;
      const sel =
        selectors ||
        'button, a, [role="button"], [role="menuitem"], [role="tab"], label, li, .btn, .card, .book-card, .toc-item, .search-result';
      const els = [...root.querySelectorAll(sel)];
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
      };
      const cands = els.filter((el) => visible(el) && norm(el.innerText || el.textContent).includes(text));
      if (!cands.length) return false;
      cands.sort((a, b) => norm(a.innerText || a.textContent).length - norm(b.innerText || b.textContent).length);
      const el = cands[0];
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    },
    { timeout },
    { text, selectors, scope }
  );
  return !!ok;
}

/** 打开书籍：点击包含书名的卡片 */
async function openBook(title) {
  await waitPageText(title);
  const ok = await page.evaluate((title) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const nodes = [...document.querySelectorAll('body *')].filter((el) => {
      const t = norm(el.innerText || '');
      return t.includes(title) && el.querySelectorAll('*').length < 40;
    });
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    for (const n of nodes) {
      const card = n.closest('.card, .book-card, .book, article, [data-book-id], [data-book], [data-id]') || n.closest('li, div');
      if (card && visible(card)) {
        card.click();
        return true;
      }
    }
    return false;
  }, title);
  if (!ok) throw new Error(`未能点击书籍卡片「${title}」`);
  await waitForReader(TIMEOUT);
}

/** 等待阅读器 iframe 出现并已有正文 */
async function waitForReader(timeout = TIMEOUT) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const frames = page.frames().filter((f) => /\/res\//.test(f.url()));
    for (const f of frames) {
      try {
        const info = await f.evaluate(() => ({
          len: document.body ? (document.body.innerText || '').trim().length : 0,
          imgs: document.images ? document.images.length : 0,
          nodes: document.body ? document.body.children.length : 0,
        }));
        if (info.len > 30 || info.imgs > 0 || info.nodes > 0) return f;
      } catch (_) {}
    }
    await sleep(200);
  }
  throw new Error(`阅读器 iframe 未出现或内容为空（已等待 ${timeout}ms）`);
}

async function readerFrame() {
  const frames = page.frames().filter((f) => /\/res\//.test(f.url()));
  return frames.length ? frames[frames.length - 1] : null;
}

async function readerText() {
  const f = await readerFrame();
  if (!f) return '';
  try {
    return await f.evaluate(() => (document.body ? document.body.innerText : ''));
  } catch (_) {
    return '';
  }
}

async function waitReaderText(substr, timeout = TIMEOUT) {
  const end = Date.now() + timeout;
  let last = '';
  while (Date.now() < end) {
    last = await readerText();
    if (last.includes(substr)) return last;
    await sleep(200);
  }
  throw new Error(`章节正文未包含「${substr}」，当前开头：${normText(last).slice(0, 100)}`);
}

async function waitReaderMatch(pattern, timeout = TIMEOUT) {
  const end = Date.now() + timeout;
  let last = '';
  while (Date.now() < end) {
    last = await readerText();
    if (pattern.test(last)) return last;
    await sleep(200);
  }
  throw new Error(`章节正文未匹配 ${pattern}，当前开头：${normText(last).slice(0, 100)}`);
}

async function goLibrary() {
  const clicked = await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const btns = [...document.querySelectorAll('button, a, [role="button"], .btn')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && /书库|返回/.test(norm(el.innerText || el.textContent));
    });
    if (!btns.length) return false;
    btns[0].click();
    return true;
  });
  if (!clicked) throw new Error('找不到「书库」返回按钮');
  await waitPageText(/导入|拖进来|书库/, TIMEOUT);
  // 等待阅读器退出
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (!page.frames().some((f) => /\/res\//.test(f.url()))) return;
    await sleep(150);
  }
  return;
}

async function findVisibleInput() {
  const handle = await page.evaluateHandle(() => {
    const inputs = [...document.querySelectorAll('input')].filter((el) => {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (!['text', 'search', 'url', ''].includes(t)) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 20 && r.height > 10 && s.visibility !== 'hidden' && s.display !== 'none';
    });
    return inputs[0] || null;
  });
  return handle.asElement();
}

/** 通过设置面板切主题 */
async function setTheme(label) {
  // 打开设置：优先 Aa，其次「设置」
  const opened = await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const btns = [...document.querySelectorAll('button, a, [role="button"], .btn, [aria-label]')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const target = btns.find((el) => /^Aa$|设置/i.test(norm(el.innerText || el.getAttribute('aria-label') || '')));
    if (!target) return false;
    target.click();
    return true;
  });
  if (!opened) throw new Error('找不到设置按钮（Aa/设置）');
  await waitPageText(/主题|夜间|字号/, 5000);
  await sleep(300);
  const switched = await page.evaluate((label) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const els = [...document.querySelectorAll('button, [role="radio"], [role="button"], label, .theme-option, [data-theme]')];
    const target = els.find((el) => {
      const t = norm(el.innerText || '');
      const r = el.getBoundingClientRect();
      return t === label && r.width > 0 && r.height > 0;
    });
    if (!target) return false;
    target.click();
    return true;
  }, label);
  if (!switched) throw new Error(`设置面板找不到主题选项「${label}」`);
  await sleep(500);
}

function parseLuminance(color) {
  const m = String(color || '').match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/);
  if (!m) return null;
  if (m[4] !== undefined && Number(m[4]) === 0) return null; // 透明
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

async function collectBackgrounds() {
  const top = await page.evaluate(() => {
    const b = document.body;
    const h = document.documentElement;
    return {
      body: b ? getComputedStyle(b).backgroundColor : null,
      html: h ? getComputedStyle(h).backgroundColor : null,
      theme: h ? h.getAttribute('data-theme') : (b ? b.getAttribute('data-theme') : null),
    };
  });
  const f = await readerFrame();
  let frame = null;
  if (f) {
    try {
      frame = await f.evaluate(() => {
        const b = document.body;
        const h = document.documentElement;
        return {
          body: b ? getComputedStyle(b).backgroundColor : null,
          html: h ? getComputedStyle(h).backgroundColor : null,
          color: b ? getComputedStyle(b).color : null,
        };
      });
    } catch (_) {}
  }
  return { top, frame };
}

/* ---- 通用 DOM 辅助（基于 web/index.html 的稳定 id） ---- */
async function waitVisible(selector, timeout = TIMEOUT) {
  const el = await page.waitForSelector(selector, { timeout, visible: true });
  if (!el) throw new Error(`元素不可见：${selector}`);
  return el;
}

async function countSel(selector) {
  return page.evaluate((s) => document.querySelectorAll(s).length, selector);
}

async function textOf(selector) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? (el.innerText || el.textContent || '') : '';
  }, selector);
}

async function waitSelectorText(selector, pattern, timeout = TIMEOUT) {
  const src = pattern instanceof RegExp ? pattern.source : String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page.waitForFunction(
    (sel, s) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      try {
        return new RegExp(s).test(el.textContent || '');
      } catch (_) {
        return false;
      }
    },
    { timeout },
    selector,
    src
  );
}

async function clickSel(selector, { timeout = TIMEOUT } = {}) {
  const el = await page.waitForSelector(selector, { timeout, visible: true });
  if (!el) throw new Error(`元素不可见：${selector}`);
  await el.click();
  return el;
}

async function openBookById(title) {
  await page.waitForFunction(
    (title) => {
      const grid = document.querySelector('#bookGrid');
      if (!grid) return false;
      const card = [...grid.querySelectorAll('.book-card')].find((c) => (c.innerText || '').includes(title));
      if (!card) return false;
      card.click();
      return true;
    },
    { timeout: TIMEOUT },
    title
  );
  await waitForReader(TIMEOUT);
}

async function waitPanelOpen(selector, open = true, timeout = 5000) {
  await page.waitForFunction(
    (sel, open) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      return el.classList.contains('open') === open;
    },
    { timeout },
    selector,
    open
  );
}

/** 给子步骤的失败附加阶段标签，便于定位 */
async function step(label, fn) {
  try {
    return await fn();
  } catch (e) {
    throw new Error(`「${label}」${e && e.message ? e.message : e}`);
  }
}

/** 等面板遮罩真正隐藏（关闭动画 260ms，期间遮罩会拦截点击） */
async function waitBackdropHidden(timeout = 3000) {
  await page.waitForFunction(
    () => {
      const b = document.querySelector('#panelBackdrop');
      return !b || b.hidden;
    },
    { timeout }
  );
}

/* ---- UI 主流程 ---- */
async function uiPhase() {
  out('\n[2/3] UI 端到端（puppeteer-core + Edge，1920×1080）');
  await launchBrowser();
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });

  /* 1. 空书库 ------------------------------------------------------- */
  await attempt('书库空状态可见', async () => {
    // 接口阶段已经导入了两本样例，先清空以确保空状态
    const list = await getJson('/api/books');
    for (const b of (list.json && list.json.books) || []) {
      await del(`/api/books/${b.id}`);
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitVisible('#emptyState');
    await waitSelectorText('#libraryCount', /0\s*本/);
    const text = normText(await pageText());
    expect(/拖进来|拖入|拖放|拖拽/.test(text), `空状态文案缺失：${text.slice(0, 160)}`);
    expect(/导入/.test(text), '缺少导入入口');
    expectEq(await countSel('#bookGrid .book-card'), 0, '空书库卡片数');
    await shot('01-library-empty.png');
    return '空状态插画/文案 + 导入按钮';
  });

  /* 1b. 拖拽遮罩 ----------------------------------------------------- */
  await attempt('拖拽遮罩：拖入文件时全屏高亮', async () => {
    const shown = await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'demo.epub', { type: 'application/epub+zip' }));
      window.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const el = document.querySelector('#dropOverlay');
      return { visible: !!el && !el.hidden, text: el ? el.innerText : '' };
    });
    expect(shown.visible, '拖入文件后未显示全屏遮罩');
    expect(/松开|导入/.test(shown.text), `遮罩文案异常：${shown.text.slice(0, 100)}`);
    await sleep(400);
    await shot('11-drag-overlay.png');
    await page.evaluate(() => {
      window.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true }));
    });
    await sleep(300);
    const hidden = await page.evaluate(() => document.querySelector('#dropOverlay').hidden);
    expect(hidden, '拖拽结束后遮罩未隐藏');
    return '全屏遮罩出现，拖拽结束后隐藏';
  });

  /* 2. API 导入 + 刷新 ---------------------------------------------- */  await attempt('API 导入两本书 → 刷新 → 卡片渲染', async () => {
    const imported = {};
    for (const p of [CN_PATH, EN_PATH]) {
      const r = await postJson('/api/books/import', { path: p });
      expectStatus(r, 200, `import ${path.basename(p)}`);
      imported[r.json.book.id] = r.json.book;
    }
    // 空库已重建：恢复「第五章」进度，用于后续「打开即恢复」断言
    const cnId = Object.keys(imported).find((id) => imported[id].title === '听书测试样书');
    expect(cnId, '未找到中文书 id');
    ids.cn = cnId;
    ids.en = Object.keys(imported).find((id) => imported[id].title === 'Pride and Prejudice');
    const patch = await patchJson(`/api/books/${cnId}`, {
      progress: { spineIndex: 4, scrollRatio: 0.25, percent: 0.72, chapterTitle: '第五章 长文练习' },
    });
    expectStatus(patch, 200, 'PATCH 进度（UI 前）');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('#bookGrid .book-card').length >= 2, { timeout: TIMEOUT });
    await waitSelectorText('#libraryCount', /2\s*本/);
    const text = normText(await pageText());
    expect(text.includes('听书测试样书'), '中文书名卡片缺失');
    expect(text.includes('测试作者'), '中文作者缺失');
    expect(text.includes('Pride and Prejudice'), '英文书名卡片缺失');
    expect(text.includes('Jane Austen'), '英文作者缺失');
    expect(!text.includes('\uFFFD'), '页面出现乱码 U+FFFD');
    await sleep(900); // 等封面图加载
    await page
      .waitForFunction(() => [...document.querySelectorAll('#bookGrid img[data-cover]')].every((img) => img.complete), { timeout: 8000 })
      .catch(() => {});
    await sleep(300);
    await shot('02-library-books.png');
    return '2 张卡片，中文/英文元数据正确';
  });

  /* 3. 打开中文书 --------------------------------------------------- */
  let readerOpened = false;
  readerOpened = await attempt('打开中文书：iframe 正文非空、中文正常', async () => {
    await openBookById('听书测试样书');
    await waitVisible('#readerView');
    await waitReaderText('听书');
    const f = await readerFrame();
    expect(f, '章节 iframe 不存在');
    const info = await f.evaluate(() => ({
      len: (document.body.innerText || '').trim().length,
      hasReplacement: document.body.innerText.includes('\uFFFD'),
      text: document.body.innerText.slice(0, 120),
    }));
    expect(info.len > 200, `正文长度仅 ${info.len}`);
    expect(!info.hasReplacement, '正文出现乱码 U+FFFD');
    await shot('03-reader-cn.png');
    return `iframe 正文 ${info.len} 字`;
  });

  /* 4. 进度恢复（API 阶段已保存第五章） ----------------------------- */
  if (readerOpened) {
    await attempt('打开时恢复进度：第 5/6 章', async () => {
      await waitSelectorText('#chapterIndicator', /第\s*5\s*\/\s*6\s*章/, 8000);
      await waitReaderText('长文练习', 8000);
      await shot('10-progress-restored.png');
      return '章节指示「第 5/6 章」，正文第五章';
    });
  }

  /* 5. 目录两级 + 点击切章 ------------------------------------------ */
  if (readerOpened) {
    await attempt('目录抽屉：两级缩进 + 点击切章', async () => {
      await clickSel('#btnToc');
      await waitPanelOpen('#tocDrawer', true);
      await page.waitForFunction(() => document.querySelectorAll('#tocList .toc-item').length >= 6, { timeout: TIMEOUT });
      const toc = await page.evaluate(() => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const items = [...document.querySelectorAll('#tocList .toc-item')];
        const find = (t) => items.find((el) => norm(el.innerText).includes(t));
        const pad = (el) => (el ? parseFloat(getComputedStyle(el).paddingLeft) : null);
        const part = find('第一部');
        const child = find('第一章');
        return {
          count: items.length,
          partText: part ? norm(part.innerText) : '',
          childText: child ? norm(child.innerText) : '',
          partPad: pad(part),
          childPad: pad(child),
        };
      });
      expect(toc.partText.includes('第一部'), '目录缺一级条目「第一部」');
      expect(toc.childText.includes('第一章'), '目录缺二级条目「第一章」');
      expect(toc.childPad > toc.partPad, `两级缩进未体现（一级 ${toc.partPad}px / 二级 ${toc.childPad}px）`);
      await sleep(500);
      await shot('04-toc.png');
      const clicked = await page.evaluate(() => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const items = [...document.querySelectorAll('#tocList .toc-item[data-spine]')];
        const el = items.find((i) => norm(i.innerText).includes('第三章'));
        if (!el) return false;
        el.click();
        return true;
      });
      expect(clicked, '目录中找不到第三章');
      await waitReaderText('朗读的节奏');
      await page.waitForFunction(() => {
        const d = document.querySelector('#tocDrawer');
        return d && !d.classList.contains('open');
      }, { timeout: 5000 });
      return `目录 ${toc.count} 项，缩进 ${toc.partPad}px→${toc.childPad}px，切到第三章`;
    });
  }

  /* 6. 搜索 --------------------------------------------------------- */
  if (readerOpened) {
    await attempt('搜索「听书」：结果 + <mark> + 点击跳章', async () => {
      await page.keyboard.down('Control');
      await page.keyboard.press('f');
      await page.keyboard.up('Control');
      await waitVisible('#searchInput', 5000);
      await waitPanelOpen('#searchPanel', true);
      await clickSel('#searchInput');
      await sleep(250); // 等 openSearch 的 focus/select 定时器
      // 中文不能可靠地用 keyboard.type 输入，用 sendCharacter（Input.insertText）逐字输入
      for (const ch of '听书') await page.keyboard.sendCharacter(ch);
      const typed = await page.evaluate(() => (document.querySelector('#searchInput') || {}).value);
      expectEq(typed, '听书', '搜索框内容');
      await page.waitForFunction(() => document.querySelectorAll('#searchResults .search-result').length > 0, { timeout: 10000 });
      const info = await page.evaluate(() => ({
        count: document.querySelectorAll('#searchResults .search-result').length,
        marks: document.querySelectorAll('#searchResults mark').length,
        summary: (document.querySelector('#searchSummary') || {}).textContent || '',
      }));
      expect(info.count >= 1, '搜索无结果');
      expect(info.marks >= 1, '搜索结果中没有 <mark> 高亮');
      expect(/找到\s*\d+\s*处结果/.test(info.summary), `搜索摘要异常：${info.summary}`);
      await sleep(400);
      await shot('05-search.png');
      await page.click('#searchResults .search-result');
      await waitPanelOpen('#searchPanel', false, 6000);
      await waitReaderText('听书');
      await page.waitForFunction(
        () => {
          const f = document.querySelector('#chapterFrame');
          try {
            return !!f.contentDocument.querySelector('mark.search-hit');
          } catch (_) {
            return false;
          }
        },
        { timeout: 8000 }
      );
      await waitBackdropHidden();
      return `${info.count} 条结果（含 mark），点击后跳章并命中高亮`;
    });
  }

  /* 7. 进度保存 + 刷新恢复 ------------------------------------------ */
  if (readerOpened) {
    await attempt('切到第五章、滚动 → 进度上报 → 刷新恢复', async () => {
      await step('等待遮罩消失', () => waitBackdropHidden());
      await step('点击目录按钮', async () => {
        const before = await page.evaluate(() => document.querySelector('#tocDrawer').className);
        await clickSel('#btnToc');
        await sleep(400);
        const after = await page.evaluate(() => ({
          cls: document.querySelector('#tocDrawer').className,
          expanded: document.querySelector('#btnToc').getAttribute('aria-expanded'),
        }));
        if (!/\bopen\b/.test(after.cls)) {
          throw new Error(`目录未打开（点击前 class="${before}"，点击后 class="${after.cls}"，aria-expanded=${after.expanded}）`);
        }
      });
      await step('等待目录项', () => page.waitForFunction(() => document.querySelectorAll('#tocList .toc-item').length >= 6, { timeout: 8000 }));
      const clicked = await page.evaluate(() => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const items = [...document.querySelectorAll('#tocList .toc-item[data-spine]')];
        const el = items.find((i) => norm(i.innerText).includes('第五章'));
        if (!el) return false;
        el.click();
        return true;
      });
      expect(clicked, '目录中找不到第五章');
      await step('等待第五章正文', () => waitReaderText('长文练习'));
      const f = await readerFrame();
      await step('滚动正文', () => f.evaluate(() => window.scrollTo(0, Math.max(200, document.documentElement.scrollHeight * 0.35))));
      await sleep(2000); // 800ms 防抖 + 请求往返
      const g = await step('GET 进度', async () => {
        const r = await getJson(`/api/books/${ids.cn}`);
        expectStatus(r, 200, 'GET progress');
        return r;
      });
      const p = g.json.book.progress || {};
      expectEq(p.spineIndex, 4, 'progress.spineIndex（第五章）');
      expect(p.percent > 0.5, `progress.percent=${p.percent}，期望 >0.5`);
      await step('等待底部百分比', () => waitSelectorText('#progressPercent', /\d+\s*%/, 5000));
      await step('刷新页面', () => page.reload({ waitUntil: 'domcontentloaded' }));
      await step('刷新后等待书卡', () => page.waitForFunction(() => document.querySelectorAll('#bookGrid .book-card').length >= 2, { timeout: TIMEOUT }));
      await step('刷新后打开书籍', () => openBookById('听书测试样书'));
      await step('等待章节指示第 5/6 章', () => waitSelectorText('#chapterIndicator', /第\s*5\s*\/\s*6\s*章/, 10000));
      const restored = await readerText();
      expect(restored.includes('长文练习'), '刷新后未恢复到第五章');
      await sleep(700);
      await shot('10-progress-restored.png');
      return `spineIndex=${p.spineIndex} percent=${p.percent}，刷新后第 5/6 章`;
    });
  }

  /* 8. 设置面板 + 夜间主题 ----------------------------------------- */
  if (readerOpened) {
    await attempt('设置面板：主题/排版/朗读控件齐全', async () => {
      await clickSel('#btnSettings');
      await waitPanelOpen('#settingsPanel', true);
      const info = await page.evaluate(() => ({
        themes: [...document.querySelectorAll('#themeOptions [data-theme-choice]')].map((b) => b.dataset.themeChoice),
        hasFont: !!document.querySelector('#settingFont'),
        hasFontSize: !!document.querySelector('#settingFontSize'),
        hasLineHeight: !!document.querySelector('#settingLineHeight'),
        hasPageWidth: !!document.querySelector('#settingPageWidth'),
        hasTtsRate: !!document.querySelector('#settingTtsRate'),
        hasTtsVoice: !!document.querySelector('#settingTtsVoice'),
        hasReset: !!document.querySelector('#btnResetSettings'),
      }));
      expectEq(info.themes.join(','), 'day,night,sepia,system', '主题选项');
      expect(info.hasFont && info.hasFontSize && info.hasLineHeight && info.hasPageWidth, '排版控件缺失');
      expect(info.hasTtsRate && info.hasTtsVoice, '朗读控件缺失');
      expect(info.hasReset, '缺少「恢复默认」按钮');
      await sleep(500);
      await shot('06-settings.png');
      return '主题 4 项 / 字体·字号·行距·页宽 / 朗读语速·音色';
    });

    await attempt('夜间主题：data-theme=night，iframe 背景变暗', async () => {
      await sleep(450); // 等设置面板滑出动画结束
      await page.click('#themeOptions [data-theme-choice="night"]');
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'night', { timeout: 5000 });
      await sleep(900);
      const bgs = await collectBackgrounds();
      const lums = [bgs.top.body, bgs.top.html, bgs.frame && bgs.frame.body, bgs.frame && bgs.frame.html]
        .map(parseLuminance)
        .filter((v) => v !== null);
      expect(lums.length > 0, '无法读取背景色');
      expect(Math.min(...lums) < 0.2, `夜间背景不够暗：${lums.map((v) => v.toFixed(2)).join(',')}`);
      await page.keyboard.press('Escape');
      await waitPanelOpen('#settingsPanel', false);
      await sleep(700);
      await shot('07-reader-night.png');
      return `data-theme=night，背景亮度 ${Math.min(...lums).toFixed(2)}`;
    });
  }

  /* 9. 朗读高亮 ----------------------------------------------------- */
  if (readerOpened) {
    await attempt('朗读：开始朗读 → .tts-current 高亮', async () => {
      await clickSel('#btnTts'); // toggle() → 打开面板并开始朗读
      await waitVisible('#ttsPlay', 5000);
      await page.waitForFunction(() => {
        const p = document.querySelector('#ttsPanel');
        return p && p.classList.contains('open');
      }, { timeout: 5000 });
      await page.waitForFunction(
        () => {
          const f = document.querySelector('#chapterFrame');
          try {
            return !!f.contentDocument.querySelector('.tts-current');
          } catch (_) {
            return false;
          }
        },
        { timeout: 10000 }
      );
      await sleep(500);
      const status = normText(await textOf('#ttsStatus'));
      expect(/正在朗读/.test(status), `TTS 状态异常：${status}`);
      await shot('08-tts-highlight.png');
      await clickSel('#ttsStop');
      await sleep(400);
      return `状态：${status}`;
    });
  }

  /* 10. 英文书（EPUB2/ncx） ---------------------------------------- */
  if (readerOpened) {
    await attempt('返回书库打开英文书：正文 + ncx 目录', async () => {
      // 关闭朗读面板 → 切回日间 → 回书库
      await clickSel('#btnCloseTtsPanel').catch(() => {});
      await sleep(300);
      await step('打开设置', () => clickSel('#btnSettings'));
      await step('等待设置面板', async () => {
        await waitPanelOpen('#settingsPanel', true);
        await sleep(450); // 等滑出动画结束再点击面板内控件
      });
      await step('切回日间主题', async () => {
        await page.click('#themeOptions [data-theme-choice="day"]');
        await page.waitForFunction(() => document.documentElement.dataset.theme === 'day', { timeout: 5000 });
      });
      await page.keyboard.press('Escape');
      await step('等待设置面板关闭', () => waitPanelOpen('#settingsPanel', false));
      await step('等待遮罩消失', () => waitBackdropHidden());
      await step('点击返回书库', () => clickSel('#btnBackLibrary'));
      await step('等待书库网格可见', () => waitVisible('#bookGrid'));
      await step('打开英文书', () => openBookById('Pride and Prejudice'));
      // Gutenberg EPUB2 的第一屏是整页封面图（wrap0000.html），点「下一章」进入正文
      await step('英文书首屏加载（封面图/正文）', async () => {
        const f = await readerFrame();
        expect(f, '英文书 iframe 不存在');
        const info = await f.evaluate(() => ({
          len: (document.body.innerText || '').trim().length,
          imgs: document.images.length,
        }));
        expect(info.len > 30 || info.imgs > 0, `首屏内容为空（len=${info.len}, imgs=${info.imgs}）`);
        return info;
      });
      await clickSel('#btnNextChapter');
      const text = await step('等待英文正文', () => waitReaderMatch(/Chapter|Bennet|Darcy|Elizabeth/i));
      expect(text.length > 300, `英文正文长度仅 ${text.length}`);
      expect(/Bennet|Darcy|Elizabeth|Chapter/i.test(text), '英文正文内容异常');
      await step('点击目录按钮', () => clickSel('#btnToc'));
      await step('等待目录打开', () => waitPanelOpen('#tocDrawer', true));
      await step('等待 ncx 目录项', () => page.waitForFunction(() => document.querySelectorAll('#tocList .toc-item[data-spine]').length >= 5, { timeout: 8000 }));
      const tocCount = await countSel('#tocList .toc-item');
      const tocText = await page.evaluate(() => document.querySelector('#tocList').innerText);
      expect(/Chapter/i.test(tocText), 'ncx 目录未渲染 Chapter 条目');
      await sleep(600);
      await shot('09-reader-en.png');
      return `英文正文 ${text.length} 字符，目录 ${tocCount} 项`;
    });
  }

  /* 11. 清理（UI 移除 + API 删除） --------------------------------- */
  await attempt('书库右键移除流程 + DELETE 清理缓存', async () => {
    ui.cleanup = true; // 收尾阶段：删除书籍后残留封面请求的 404 不计入异常
    // 关闭英文书的目录抽屉后回书库
    await page.keyboard.press('Escape');
    await sleep(400);
    await clickSel('#btnBackLibrary');
    await step('等待书库网格', () => waitVisible('#bookGrid'));
    await step('等待封面加载完成', () =>
      page.waitForFunction(
        () => [...document.querySelectorAll('#bookGrid img[data-cover]')].every((img) => img.complete && img.naturalWidth > 0),
        { timeout: 8000 }
      )
    );
    // 右键「Pride and Prejudice」卡片 → 从书库移除 → 确认
    await step('右键打开卡片菜单', async () => {
      const opened = await page.evaluate(() => {
        const card = [...document.querySelectorAll('#bookGrid .book-card')].find((c) =>
          (c.innerText || '').includes('Pride and Prejudice')
        );
        if (!card) return false;
        card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 500, clientY: 400 }));
        return !document.querySelector('#cardMenu').hidden;
      });
      expect(opened, '右键卡片后菜单未出现');
    });
    await step('点击「从书库移除」', async () => {
      await clickSel('#cardMenu [data-menu-action="remove"]');
      await page.waitForFunction(() => !document.querySelector('#confirmModal').hidden, { timeout: 5000 });
    });
    await step('确认移除', async () => {
      await clickSel('#confirmOk');
      await page.waitForFunction(() => document.querySelectorAll('#bookGrid .book-card').length === 1, { timeout: 8000 });
    });
    // 先离开页面取消残留的封面懒加载请求，再 DELETE 最后一本
    await page.goto('about:blank');
    const r = await del(`/api/books/${ids.cn}`);
    expectStatus(r, 200, 'DELETE 中文书');
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await waitVisible('#emptyState');
    await waitSelectorText('#libraryCount', /0\s*本/);
    const list = await getJson('/api/books');
    expectEq(list.json.books.length, 0, '删除后书籍数');
    await sleep(300);
    for (const id of [ids.cn, ids.en]) {
      const dir = path.join(DATA_DIR, 'books', id);
      expect(!fs.existsSync(dir), `缓存目录未清理：${dir}`);
    }
    return 'UI 右键移除 + API DELETE，书库为空、缓存清理';
  });
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
function summary() {
  out('\n' + '='.repeat(64));
  out(`结果：${R.fail.length ? 'FAIL' : 'PASS'}   ✓ ${R.pass.length} 通过 · ✗ ${R.fail.length} 失败 · ! ${R.warn.length} 警告`);
  if (R.fail.length) {
    out('\n失败项：');
    R.fail.forEach((f, i) => out(`  ${i + 1}. ${f.name}${f.detail ? `\n     ${f.detail}` : ''}`));
  }
  if (R.warn.length) {
    out('\n警告项：');
    R.warn.forEach((w, i) => out(`  ${i + 1}. ${w.name}${w.detail ? `\n     ${w.detail}` : ''}`));
  }
  if (ui.pageErrors.length) {
    out(`\n页面 JS 异常（${ui.pageErrors.length}）：`);
    ui.pageErrors.slice(0, 10).forEach((e) => out('  - ' + e));
  }
  if (ui.consoleErrors.length) {
    out(`\n控制台 error（${ui.consoleErrors.length}）：`);
    ui.consoleErrors.slice(0, 10).forEach((e) => out('  - ' + e));
  }
  if (ui.failedRequests.length) {
    out(`\n失败请求（${ui.failedRequests.length}）：`);
    ui.failedRequests.slice(0, 10).forEach((e) => out('  - ' + e));
  }
  if (ui.httpErrors.length) {
    out(`\nHTTP 4xx/5xx（${ui.httpErrors.length}）：`);
    ui.httpErrors.slice(0, 10).forEach((e) => out('  - ' + e));
  }
  if (R.shots.length) {
    const unique = [...new Set(R.shots)];
    out(`\n截图（${unique.length}）：`);
    unique.forEach((s) => out('  ' + path.relative(ROOT, s)));
  }
  out('='.repeat(64));
  return R.fail.length === 0 && ui.pageErrors.length === 0;
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */
async function main() {
  out('听书 · EPUB 播放器 E2E');
  out(`  项目根：${ROOT}`);
  out(`  模式：${API_ONLY ? 'API only' : HEADED ? 'headed' : 'headless'}，视口 1920×1080`);

  // 样例
  for (const f of [CN_PATH, EN_PATH]) {
    if (!fs.existsSync(f)) {
      out(`\n样例缺失，运行 test/gen-fixtures.mjs 生成……`);
      execFileSync(process.execPath, [path.join(__dirname, 'gen-fixtures.mjs')], { cwd: ROOT, stdio: 'inherit' });
      break;
    }
  }
  if (!fs.existsSync(CN_PATH) || !fs.existsSync(EN_PATH)) {
    throw new Error('测试样例缺失，无法继续');
  }

  // 数据目录
  if (!KEEP_DATA) fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 截图目录
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const f of fs.readdirSync(SHOTS)) {
    if (/\.png$/i.test(f)) fs.rmSync(path.join(SHOTS, f), { force: true });
  }

  let server = null;
  try {
    out('\n[0/3] 启动本地服务（PORT=0）');
    server = await startServer();
    BASE = `http://127.0.0.1:${server.port}`;
    pass('服务启动并输出 LISTENING', `${BASE}（pid ${server.child.pid}）`);

    await apiPhase();

    if (!API_ONLY) {
      await uiPhase();
      out('\n[3/3] 收尾');
    }
  } catch (e) {
    fail('E2E 运行异常', e && e.stack ? e.stack.split('\n').slice(0, 6).join(' | ') : String(e));
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopServer();
    if (!KEEP_DATA) fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  const ok = summary();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('E2E 致命错误：', e);
  process.exit(1);
});
