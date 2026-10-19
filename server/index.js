'use strict';

/**
 * 听书播放器本地 HTTP 服务。
 *
 * 默认监听 127.0.0.1:8787（PORT 覆盖）。接口契约见 docs/API.md。
 *
 * 该模块导出可编程启动函数，供桌面壳（Electron 主进程）内嵌：
 *
 *   const { start } = require('./server');
 *   const { port, server } = await start({ port: 0, dataDir: '...' });
 *
 * 直接运行（node server/index.js）时，会在监听成功后向 stdout 输出唯一一行：
 *   LISTENING <port>
 * 供 E2E 脚本解析实际端口（PORT=0 时是随机端口）。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { Library } = require('./library');
const epub = require('./epub');
const tts = require('./tts');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(PROJECT_ROOT, 'web');
const DEFAULT_DATA_DIR = path.join(PROJECT_ROOT, 'data');
const DEFAULT_PORT = 8787;
const PORT_RETRY_RANGE = 20;

const BODY_LIMIT_JSON = 4 * 1024 * 1024;
const BODY_LIMIT_IMPORT_BYTES = 160 * 1024 * 1024;
const MAX_IMPORT_BYTES = 128 * 1024 * 1024;

// 与 docs/API.md §2 完全一致
const RESOURCE_CSP =
  "default-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:";

const VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
    return pkg.version || '1.0.0';
  } catch {
    return '1.0.0';
  }
})();

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* 响应工具                                                            */
/* ------------------------------------------------------------------ */

function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, status, payload, extraHeaders) {
  if (res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', body.length);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value);
  }
  if (res._headOnly) res.end();
  else res.end(body);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

function sendBuffer(res, status, buffer, headers) {
  if (res.writableEnded) return;
  res.statusCode = status;
  if (headers) {
    for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  }
  res.setHeader('Content-Length', buffer.length);
  if (res._headOnly) res.end();
  else res.end(buffer);
}

function sendText(res, status, text, contentType) {
  if (res.writableEnded) return;
  const body = Buffer.from(String(text), 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', contentType || 'text/plain; charset=utf-8');
  res.setHeader('Content-Length', body.length);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (res._headOnly) res.end();
  else res.end(body);
}

/* ------------------------------------------------------------------ */
/* 请求工具                                                            */
/* ------------------------------------------------------------------ */

function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        reject(new ApiError(413, 'PAYLOAD_TOO_LARGE', `请求体过大（上限 ${Math.round(limit / 1024 / 1024)}MB）`));
        try {
          req.destroy();
        } catch {
          /* 忽略 */
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(new ApiError(400, 'BAD_REQUEST', `读取请求体失败：${error.message}`));
    });
  });
}

async function readJsonBody(req, limit) {
  const buffer = await readRawBody(req, limit || BODY_LIMIT_JSON);
  const text = buffer.toString('utf8').trim();
  if (!text) return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ApiError(400, 'BAD_REQUEST', '请求体不是合法 JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'BAD_REQUEST', '请求体必须是 JSON 对象');
  }
  return value;
}

function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parsePathSegments(pathname) {
  const parts = String(pathname || '/').split('/');
  // 去掉开头的空串（绝对路径以 '/' 开头）
  if (parts.length && parts[0] === '') parts.shift();
  // 忽略空段（'/' → []、'/web/' → ['web']），同时逐段 URL 解码
  return parts.filter((part) => part !== '').map(decodePathSegment);
}

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(Math.max(numeric, min), max);
}

/* ------------------------------------------------------------------ */
/* 业务逻辑                                                            */
/* ------------------------------------------------------------------ */

function isPathInside(rootDir, targetPath) {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetPath);
  return target === root || target.startsWith(root + path.sep);
}

function createApp(dataDir) {
  const library = new Library(dataDir);
  // 清理上次异常退出遗留的导入临时文件（只清理 1 小时前的，避免误删其他进程正在写入的文件）
  try {
    const tmpDir = path.join(dataDir, 'tmp');
    if (fs.existsSync(tmpDir)) {
      const expiredBefore = Date.now() - 60 * 60 * 1000;
      for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
        if (entry.isDirectory()) continue;
        const file = path.join(tmpDir, entry.name);
        try {
          if (fs.statSync(file).mtimeMs < expiredBefore) fs.rmSync(file, { force: true });
        } catch {
          /* 忽略 */
        }
      }
    }
  } catch {
    /* 清理失败不影响服务启动 */
  }
  return { dataDir, library };
}

function publicBook(book) {
  if (book && !book.fingerprint && fs.existsSync(book.path)) { book.fingerprint = crypto.createHash('sha256').update(fs.readFileSync(book.path)).digest('hex'); }
  if (!book) return null;
  const result = {
    id: book.id,
    fingerprint: book.fingerprint || '',
    progressUpdatedAt: book.progressUpdatedAt || 0,
    path: book.path,
    title: book.title,
    author: book.author,
    addedAt: book.addedAt,
    lastReadAt: book.lastReadAt,
    progress: book.progress,
    spineCount: book.spineCount
  };
  if (book.publisher) result.publisher = book.publisher;
  if (book.language) result.language = book.language;
  if (book.description) result.description = book.description;
  if (book.cover) result.cover = book.cover;
  return result;
}

/**
 * 导入（或重新导入）一本书：解析 + 解包 + 更新书库。
 * 重复导入保留 addedAt / lastReadAt / progress。
 */
function performImport(app, absPath) {
  const id = epub.sha1Id(absPath);
  const existing = app.library.get(id);
  let result;
  try {
    result = epub.ingest({ filePath: absPath, dataDir: app.dataDir, id });
  } catch (error) {
    if (error instanceof epub.EpubError) {
      throw new ApiError(400, error.code || 'EPUB_INVALID', error.message);
    }
    throw error;
  }
  const now = Date.now();
  const book = {
    id: result.id,
    fingerprint: crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex'),
    progressUpdatedAt: existing ? existing.progressUpdatedAt : 0,
    path: result.path,
    title: result.summary.title,
    author: result.summary.author,
    publisher: result.summary.publisher,
    language: result.summary.language,
    description: result.summary.description,
    cover: result.summary.cover,
    addedAt: existing ? existing.addedAt : now,
    lastReadAt: existing ? existing.lastReadAt : now,
    progress: existing ? existing.progress : { spineIndex: 0, scrollRatio: 0, percent: 0, chapterTitle: '' },
    spineCount: result.summary.spineCount
  };
  const saved = app.library.upsert(book);
  return publicBook(saved);
}

function requireBook(app, id) {
  const book = app.library.get(id);
  if (!book) throw new ApiError(404, 'NOT_FOUND', '书籍不存在');
  return book;
}

function ensureMeta(app, book) {
  let meta = epub.loadMeta(app.dataDir, book.id);
  if (meta) return meta;
  // 缓存被手动清理时尝试从原文件重建
  if (!book.path || !fs.existsSync(book.path)) {
    throw new ApiError(404, 'FILE_MISSING', '书籍文件已丢失，请重新导入');
  }
  try {
    epub.ingest({ filePath: book.path, dataDir: app.dataDir, id: book.id });
  } catch (error) {
    throw new ApiError(500, 'BOOK_CORRUPT', `书籍解析失败：${error.message}`);
  }
  meta = epub.loadMeta(app.dataDir, book.id);
  if (!meta) throw new ApiError(500, 'BOOK_CORRUPT', '书籍解析结果不可用，请重新导入');
  return meta;
}

/* ------------------------------------------------------------------ */
/* 路由：书库 API                                                      */
/* ------------------------------------------------------------------ */

async function handleApi(app, req, res, method, parts, url) {
  if (parts[1] === 'stella' && parts[2] === 'lan') {
    const stella = require('./stella');
    const result = method === 'POST' ? await stella.enable(app) : method === 'DELETE' ? stella.disable(app) : stella.info(app);
    sendJson(res, 200, result); return;
  }
  // /api/health
  if (parts.length === 2 && parts[1] === 'health') {
    if (method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '只支持 GET');
    sendJson(res, 200, { ok: true, version: VERSION, platform: process.platform });
    return;
  }

  if (parts[1] === 'voice-preferences') {
    const file=path.join(app.dataDir,'voice-preferences.json');
    if(method==='POST'){const body=await readJsonBody(req);fs.writeFileSync(file,JSON.stringify({ttsVoice:String(body.ttsVoice||'').slice(0,300),ttsRate:clampNumber(body.ttsRate,.6,2)||1}));}
    let preferences={ttsVoice:'',ttsRate:1};try{preferences=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}sendJson(res,200,preferences);return;
  }
  if (parts[1] === 'voices') {
    sendJson(res, 200, await require('./voices').list(app.dataDir)); return;
  }
  if (parts[1] === 'voice-config') {
    const v=require('./voices');
    sendJson(res, 200, method==='POST' ? v.save(app.dataDir,await readJsonBody(req)) : v.safe(v.load(app.dataDir))); return;
  }
  // /api/tts
  if (parts.length === 2 && parts[1] === 'tts') {
    if (method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '只支持 POST');
    const body = await readJsonBody(req, BODY_LIMIT_JSON);
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) throw new ApiError(400, 'BAD_REQUEST', 'text 不能为空');
    if (text.length > 5000) throw new ApiError(400, 'BAD_REQUEST', 'text 过长（一次最多 5000 字）');
    if (/^(edge|pc|azure|openai):/.test(body.voice || '')) {
      const result = await require('./voices').synthesize(app.dataDir,body);
      sendBuffer(res,200,result.buffer,{'Content-Type':result.mime,'Cache-Control':'no-store'}); return;
    }
    let wav;
    try {
      wav = await tts.synthesize(text, body.rate);
    } catch (error) {
      throw new ApiError(500, 'TTS_FAILED', `语音合成失败：${error.message || '未知错误'}`);
    }
    sendBuffer(res, 200, wav, {
      'Content-Type': 'audio/wav',
      'Content-Length': wav.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    return;
  }

  if (parts.length < 2 || parts[1] !== 'books') {
    throw new ApiError(404, 'NOT_FOUND', '接口不存在');
  }

  // /api/books
  if (parts.length === 2) {
    if (method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '只支持 GET');
    sendJson(res, 200, { books: app.library.list().map(publicBook) });
    return;
  }

  // /api/books/import
  if (parts[2] === 'import' && parts.length === 3) {
    if (method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '只支持 POST');
    const body = await readJsonBody(req, BODY_LIMIT_JSON);
    const rawPath = typeof body.path === 'string' ? body.path.trim() : '';
    if (!rawPath) throw new ApiError(400, 'BAD_REQUEST', 'path 不能为空（需要 EPUB 文件的绝对路径）');
    if (!/\.epub$/i.test(rawPath)) throw new ApiError(400, 'BAD_REQUEST', '仅支持导入 .epub 文件');
    const absPath = path.resolve(rawPath);
    let stat;
    try {
      stat = fs.statSync(absPath);
    } catch {
      throw new ApiError(400, 'BAD_REQUEST', `文件不存在：${absPath}`);
    }
    if (!stat.isFile()) throw new ApiError(400, 'BAD_REQUEST', 'path 不是文件');
    if (stat.size === 0) throw new ApiError(400, 'BAD_REQUEST', 'EPUB 文件为空');
    const book = performImport(app, absPath);
    sendJson(res, 200, { book });
    return;
  }

  // /api/books/import-bytes
  if (parts[2] === 'import-bytes' && parts.length === 3) {
    if (method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '只支持 POST');
    const body = await readJsonBody(req, BODY_LIMIT_IMPORT_BYTES);
    const rawName = typeof body.name === 'string' ? body.name.trim() : '';
    if (!rawName) throw new ApiError(400, 'BAD_REQUEST', 'name 不能为空');
    if (!/\.epub$/i.test(rawName)) throw new ApiError(400, 'BAD_REQUEST', '仅支持导入 .epub 文件');
    const base64 = typeof body.dataBase64 === 'string'
      ? body.dataBase64
      : typeof body.data === 'string'
        ? body.data
        : '';
    if (!base64) throw new ApiError(400, 'BAD_REQUEST', 'dataBase64 不能为空');
    const cleanedBase64 = base64.replace(/^data:[^,]*,/, '');
    let buffer;
    try {
      buffer = Buffer.from(cleanedBase64, 'base64');
    } catch {
      throw new ApiError(400, 'BAD_REQUEST', 'dataBase64 不是合法 base64');
    }
    if (!buffer.length) throw new ApiError(400, 'BAD_REQUEST', '文件内容为空');
    if (buffer.length > MAX_IMPORT_BYTES) {
      throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `EPUB 文件过大（上限 ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)}MB）`);
    }

    const contentHash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16);
    const tmpDir = path.join(app.dataDir, 'tmp');
    const sourcesDir = path.join(app.dataDir, 'sources');
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(sourcesDir, { recursive: true });
    const safeName =
      path
        .basename(rawName)
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
        .slice(-100) || 'book.epub';
    const tmpPath = path.join(
      tmpDir,
      `${contentHash}-${Date.now()}-${Math.random().toString(16).slice(2)}-${safeName}`
    );
    // 长期保存的源文件：按内容哈希命名，book.path 指向它；
    // 重复拖入同一文件会命中同一本书（保留进度），删书后也能从源文件重建缓存。
    const sourcePath = path.join(sourcesDir, `${contentHash}.epub`);
    fs.writeFileSync(tmpPath, buffer);
    let createdSource = false;
    try {
      if (!fs.existsSync(sourcePath)) {
        try {
          fs.renameSync(tmpPath, sourcePath);
        } catch {
          fs.copyFileSync(tmpPath, sourcePath);
        }
        createdSource = true;
      }
      const book = performImport(app, sourcePath);
      sendJson(res, 200, { book });
    } catch (error) {
      // 导入失败且源文件是本次新建的：回滚，避免留下损坏文件
      if (createdSource) {
        try {
          fs.rmSync(sourcePath, { force: true });
        } catch {
          /* 忽略 */
        }
      }
      throw error;
    } finally {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        /* 忽略：临时文件删除失败不影响导入结果 */
      }
    }
    return;
  }

  const id = parts[2];
  if (!id) throw new ApiError(404, 'NOT_FOUND', '接口不存在');
  const rest = parts.slice(3);

  // /api/books/:id/cover
  if (rest.length === 1 && rest[0] === 'cover') {
    if (method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '只支持 GET');
    const book = requireBook(app, id);
    const meta = ensureMeta(app, book);
    if (!meta.coverHref) throw new ApiError(404, 'NO_COVER', '本书没有封面');
    const resolved = epub.resolveBookFile(app.dataDir, id, meta.coverHref);
    if (resolved.status !== 200) throw new ApiError(404, 'NO_COVER', '本书没有封面');
    let buffer;
    try {
      buffer = fs.readFileSync(resolved.file);
    } catch {
      throw new ApiError(404, 'NO_COVER', '本书没有封面');
    }
    sendBuffer(res, 200, buffer, {
      'Content-Type': epub.contentTypeFor(meta.coverHref, buffer),
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    return;
  }

  // /api/books/:id/search
  if (rest.length === 1 && rest[0] === 'search') {
    if (method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '只支持 GET');
    const book = requireBook(app, id);
    const meta = ensureMeta(app, book);
    const query = String(url.searchParams.get('q') || '').slice(0, 200);
    const results = epub.searchBook(app.dataDir, meta, query, { limit: 50 });
    sendJson(res, 200, { results });
    return;
  }

  // /api/books/:id/res/<path>
  if (rest.length >= 1 && rest[0] === 'res') {
    if (method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '只支持 GET');
    requireBook(app, id);
    const relativePath = rest.slice(1).join('/');
    const resolved = epub.resolveBookFile(app.dataDir, id, relativePath);
    if (resolved.status === 403) throw new ApiError(403, 'FORBIDDEN', '路径越界，禁止访问');
    if (resolved.status !== 200) throw new ApiError(404, 'NOT_FOUND', '资源不存在');
    let buffer;
    try {
      buffer = fs.readFileSync(resolved.file);
    } catch {
      throw new ApiError(404, 'NOT_FOUND', '资源不存在');
    }
    sendBuffer(res, 200, buffer, {
      'Content-Type': epub.contentTypeFor(relativePath, buffer),
      'Content-Security-Policy': RESOURCE_CSP,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    return;
  }

  if (rest.length !== 0) throw new ApiError(404, 'NOT_FOUND', '接口不存在');

  // /api/books/:id
  if (method === 'GET') {
    const book = requireBook(app, id);
    const meta = ensureMeta(app, book);
    sendJson(res, 200, { book: publicBook(book), spine: meta.spine, toc: meta.toc });
    return;
  }

  if (method === 'PATCH') {
    requireBook(app, id);
    const body = await readJsonBody(req, BODY_LIMIT_JSON);
    if (body.progress !== undefined && (body.progress === null || typeof body.progress !== 'object' || Array.isArray(body.progress))) {
      throw new ApiError(400, 'BAD_REQUEST', 'progress 必须是对象');
    }
    if (body.lastReadAt !== undefined && !Number.isFinite(Number(body.lastReadAt))) {
      throw new ApiError(400, 'BAD_REQUEST', 'lastReadAt 必须是毫秒时间戳');
    }
    const patch = {};
    if (body.progressUpdatedAt !== undefined) patch.progressUpdatedAt = Number(body.progressUpdatedAt);
    if (body.progress !== undefined) patch.progress = body.progress;
    if (body.lastReadAt !== undefined) patch.lastReadAt = Number(body.lastReadAt);
    const updated = app.library.patch(id, patch);
    if (!updated) throw new ApiError(404, 'NOT_FOUND', '书籍不存在');
    sendJson(res, 200, { ok: true, book: publicBook(updated) });
    return;
  }

  if (method === 'DELETE') {
    const book = requireBook(app, id);
    app.library.remove(book.id);
    epub.clearBookCache(app.dataDir, book.id);
    // import-bytes 落盘的源文件一并清理；用户自有路径的 epub 绝不删除
    try {
      const sourcesDir = path.join(app.dataDir, 'sources');
      if (book.path && isPathInside(sourcesDir, book.path) && fs.existsSync(book.path)) {
        fs.rmSync(book.path, { force: true });
      }
    } catch (error) {
      console.error('[server] 清理 sources 源文件失败：', error.message);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  throw new ApiError(405, 'METHOD_NOT_ALLOWED', `不支持的方法：${method}`);
}

/* ------------------------------------------------------------------ */
/* 路由：静态资源                                                      */
/* ------------------------------------------------------------------ */

/**
 * 静态资源按扩展名给 Content-Type（HTML5 页面不能用 xmlns 启发式：
 * `.html` 一律 text/html，只有 `.xhtml` 才是 application/xhtml+xml）。
 */
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xhtml': 'application/xhtml+xml; charset=utf-8',
  '.xht': 'application/xhtml+xml; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
};

function staticContentType(filePath) {
  return STATIC_MIME[path.extname(String(filePath || '')).toLowerCase()] || 'application/octet-stream';
}

/** 把前端相对路径解析到 web/ 或 web/public/ 下的真实文件。 */
function resolveStaticFile(relativePath) {
  const normalized = epub.normalizeEpubPath(relativePath);
  if (!normalized) return { status: 403 };
  const candidateRoots = [WEB_DIR, path.join(WEB_DIR, 'public')];
  for (const rootDir of candidateRoots) {
    const root = path.resolve(rootDir);
    const target = path.resolve(root, normalized);
    if (!(target === root || target.startsWith(root + path.sep))) continue; // 越界
    try {
      const stat = fs.statSync(target);
      if (stat.isFile()) return { status: 200, file: target };
    } catch {
      /* 尝试下一个根目录 */
    }
  }
  return { status: 404 };
}

/** 返回 true 表示已响应；false 表示未找到。 */
function serveStaticFile(res, relativePath) {
  const resolved = resolveStaticFile(relativePath);
  if (resolved.status === 403) {
    sendText(res, 403, '路径越界，禁止访问');
    return true;
  }
  if (resolved.status !== 200) return false;
  const buffer = fs.readFileSync(resolved.file);
  sendBuffer(res, 200, buffer, {
    'Content-Type': staticContentType(resolved.file),
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  });
  return true;
}

/* ------------------------------------------------------------------ */
/* 主请求处理                                                          */
/* ------------------------------------------------------------------ */

async function handleRequest(app, req, res) {
  applyCors(res);
  res.on('error', () => {
    /* 客户端提前断开时忽略 */
  });
  const headOnly = req.method === 'HEAD';
  if (headOnly) res._headOnly = true;
  const method = headOnly ? 'GET' : req.method;

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  let url;
  try {
    url = new URL(req.url, 'http://127.0.0.1');
  } catch {
    throw new ApiError(400, 'BAD_REQUEST', '无效的请求地址');
  }

  const parts = parsePathSegments(url.pathname);

  if (parts[0] === 'api') {
    if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) { throw new ApiError(403,'FORBIDDEN','仅允许本机阅读器访问'); }
    await handleApi(app, req, res, method, parts, url);
    return;
  }

  if (method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '只支持 GET');

  // 静态资源：'/' → web/index.html；'/web/*' 以及 '/js/app.js' 这类无前缀路径，
  // 都按 web/<path> → web/public/<path> 的顺序兜底。
  let relativePath;
  if (parts.length === 0) relativePath = 'index.html';
  else if (parts[0] === 'web') relativePath = parts.slice(1).join('/') || 'index.html';
  else relativePath = parts.join('/');

  if (serveStaticFile(res, relativePath)) return;
  if (relativePath === 'index.html') {
    sendText(res, 404, '前端页面尚未创建：web/index.html');
    return;
  }
  sendText(res, 404, `页面不存在：${relativePath}`);
}

function handleError(res, error) {
  if (res.writableEnded) return;
  if (error instanceof ApiError) {
    sendError(res, error.status, error.code, error.message);
    return;
  }
  if (error instanceof epub.EpubError) {
    sendError(res, 400, error.code || 'EPUB_INVALID', error.message);
    return;
  }
  console.error('[server] 未处理异常：', error);
  try {
    sendError(res, 500, 'INTERNAL', `服务器内部错误：${error.message || '未知错误'}`);
  } catch {
    try {
      res.end();
    } catch {
      /* 忽略 */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

const appCache = new Map();

function resolveDataDir(dataDir) {
  if (dataDir) return path.resolve(String(dataDir));
  const fromEnv = process.env.DATA_DIR;
  if (fromEnv && String(fromEnv).trim()) return path.resolve(fromEnv);
  return DEFAULT_DATA_DIR;
}

function getApp(dataDir) {
  const resolved = resolveDataDir(dataDir);
  if (!appCache.has(resolved)) appCache.set(resolved, createApp(resolved));
  return appCache.get(resolved);
}

function listenOnce(handler, port, host) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on('clientError', (error, socket) => {
      try {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      } catch {
        /* 忽略 */
      }
    });
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen({ port, host });
    } catch (error) {
      server.removeListener('error', onError);
      reject(error);
    }
  });
}

/**
 * 启动服务（可编程，不调用 process.exit）。
 *
 * @param {{ port?: number|string, dataDir?: string, host?: string }} [options]
 * @returns {Promise<{ port: number, server: import('http').Server, dataDir: string }>}
 */
async function start(options) {
  const opts = options || {};
  let requested = opts.port;
  if (requested === undefined || requested === null || requested === '') {
    const envPort = Number(process.env.PORT);
    requested =
      process.env.PORT !== undefined && String(process.env.PORT).trim() !== '' && Number.isFinite(envPort)
        ? envPort
        : DEFAULT_PORT;
  }
  requested = Number(requested);
  if (!Number.isInteger(requested) || requested < 0 || requested > 65535) requested = DEFAULT_PORT;

  const host = opts.host || process.env.HOST || '127.0.0.1';
  const dataDir = resolveDataDir(opts.dataDir);
  const app = getApp(dataDir);
  await require('./stella').restore(app);
  const handler = (req, res) => {
    handleRequest(app, req, res).catch((error) => handleError(res, error));
  };

  const candidates = [];
  if (requested === 0) {
    candidates.push(0);
  } else {
    for (let offset = 0; offset <= PORT_RETRY_RANGE; offset += 1) {
      const candidate = requested + offset;
      if (candidate <= 65535) candidates.push(candidate);
    }
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const server = await listenOnce(handler, candidate, host);
      server.on('error', (error) => {
        console.error('[server] HTTP 服务错误：', error.message);
      });
      return { port: server.address().port, server, dataDir };
    } catch (error) {
      lastError = error;
      if (error && error.code === 'EADDRINUSE') continue;
      throw error;
    }
  }

  const error = new Error(
    `端口 ${requested} 及后续 ${PORT_RETRY_RANGE} 个端口均被占用，无法启动服务`
  );
  error.code = 'EADDRINUSE';
  error.cause = lastError;
  throw error;
}

module.exports = { start, VERSION, DEFAULT_PORT };

/* 直接运行时：启动并输出 E2E 契约行 `LISTENING <port>` */
if (require.main === module) {
  start()
    .then(({ port, server }) => {
      // 必须是 stdout 的独立一行，E2E 依赖该格式解析端口
      console.log(`LISTENING ${port}`);
      const shutdown = () => {
        try {
          server.close(() => process.exit(0));
        } catch {
          process.exit(0);
        }
        const timer = setTimeout(() => process.exit(0), 1500);
        if (timer.unref) timer.unref();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((error) => {
      console.error(`服务启动失败：${error && error.message ? error.message : error}`);
      process.exitCode = 1;
    });
}
