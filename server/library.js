'use strict';

/**
 * 书库元数据持久化。
 *
 * 存储位置：<DATA_DIR>/library.json
 * 结构：{ version: 1, books: [Book, ...] }
 *
 * 写入策略：
 *  - 原子写：先写同目录临时文件，再 rename 覆盖正式文件；
 *  - 同步写 + 失败重试（Windows 上 rename 偶尔会被杀软/索引器短暂占用）；
 *  - 单进程内串行执行，避免并发写互相覆盖。
 */

const fs = require('fs');
const path = require('path');

const LIBRARY_VERSION = 1;

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* 忽略：极端环境下退化为忙等 */
  }
}

function clamp01(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  if (number < 0) return 0;
  if (number > 1) return 1;
  return number;
}

function normalizeProgress(progress, fallback) {
  const source = progress && typeof progress === 'object' ? progress : {};
  const base = fallback || { spineIndex: 0, scrollRatio: 0, percent: 0, chapterTitle: '' };
  const spineIndex = Number.isInteger(source.spineIndex) && source.spineIndex >= 0 ? source.spineIndex : base.spineIndex || 0;
  return {
    spineIndex,
    locator: source.locator && typeof source.locator === 'object' ? { paragraph: Math.max(0, Math.floor(Number(source.locator.paragraph)||0)), text: String(source.locator.text||'').slice(0,100), offset: clamp01(source.locator.offset,0) } : base.locator || null,
    scrollRatio: clamp01(source.scrollRatio, base.scrollRatio || 0),
    percent: clamp01(source.percent, base.percent || 0),
    chapterTitle: typeof source.chapterTitle === 'string' ? source.chapterTitle : base.chapterTitle || ''
  };
}

function normalizeBook(raw) {
  const book = raw && typeof raw === 'object' ? raw : {};
  const addedAt = Number.isFinite(book.addedAt) ? book.addedAt : Date.now();
  const lastReadAt = Number.isFinite(book.lastReadAt) ? book.lastReadAt : addedAt;
  const normalized = {
    id: String(book.id || ''),
    path: String(book.path || ''),
    title: typeof book.title === 'string' && book.title.trim() ? book.title : '未命名书籍',
    author: typeof book.author === 'string' && book.author.trim() ? book.author : '未知作者',
    addedAt,
    lastReadAt,
    fingerprint: typeof book.fingerprint === 'string' ? book.fingerprint : '',
    progressUpdatedAt: Number.isFinite(book.progressUpdatedAt) ? book.progressUpdatedAt : (book.progress ? lastReadAt : 0),
    progress: normalizeProgress(book.progress),
    spineCount: Number.isInteger(book.spineCount) && book.spineCount >= 0 ? book.spineCount : 0
  };
  if (typeof book.publisher === 'string' && book.publisher) normalized.publisher = book.publisher;
  if (typeof book.language === 'string' && book.language) normalized.language = book.language;
  if (typeof book.description === 'string' && book.description) normalized.description = book.description;
  if (typeof book.cover === 'string' && book.cover) normalized.cover = book.cover;
  return normalized;
}

class Library {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'library.json');
    this.books = [];
    this._writeQueue = Promise.resolve();
    fs.mkdirSync(dataDir, { recursive: true });
    this._load();
  }

  _load() {
    if (!fs.existsSync(this.file)) {
      this.books = [];
      return;
    }
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.books) ? parsed.books : [];
      this.books = list.filter((book) => book && typeof book === 'object' && book.id).map(normalizeBook);
      // 读入后立即回写一次，把旧版本/脏数据规范化
      this._writeNow();
    } catch (error) {
      // 文件损坏：备份后用空书库启动，避免服务起不来
      try {
        fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        /* 忽略备份失败 */
      }
      this.books = [];
      try {
        this._writeNow();
      } catch {
        /* 忽略 */
      }
      console.error('[library] library.json 解析失败，已重置：', error.message);
    }
  }

  _serialize() {
    return JSON.stringify({ version: LIBRARY_VERSION, books: this.books }, null, 2);
  }

  _writeNow() {
    const payload = this._serialize();
    const tmpFile = `${this.file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(tmpFile, payload, 'utf8');
    let lastError = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        fs.renameSync(tmpFile, this.file);
        return;
      } catch (error) {
        lastError = error;
        sleepSync(20 * (attempt + 1));
      }
    }
    // rename 持续失败（少见）：退回直接覆盖写
    try {
      fs.writeFileSync(this.file, payload, 'utf8');
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* 忽略 */
      }
    }
    if (lastError) console.error('[library] 原子写 rename 失败，已退回直接写：', lastError.message);
  }

  /** 串行保存（返回 Promise，便于调用方 await）。 */
  save() {
    this._writeQueue = this._writeQueue.then(() => this._writeNow()).catch((error) => {
      console.error('[library] 保存失败：', error.message);
    });
    return this._writeQueue;
  }

  list() {
    return [...this.books].sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0));
  }

  get(id) {
    if (!id) return null;
    return this.books.find((book) => book.id === id) || null;
  }

  upsert(book) {
    const normalized = normalizeBook(book);
    const index = this.books.findIndex((item) => item.id === normalized.id);
    if (index >= 0) this.books[index] = normalized;
    else this.books.push(normalized);
    this._writeNow();
    return normalized;
  }

  remove(id) {
    const index = this.books.findIndex((book) => book.id === id);
    if (index < 0) return false;
    this.books.splice(index, 1);
    this._writeNow();
    return true;
  }

  /**
   * 局部更新（PATCH）。
   * @returns {object|null} 更新后的 Book；不存在返回 null
   */
  patch(id, patch) {
    const book = this.get(id);
    if (!book) return null;
    const source = patch && typeof patch === 'object' ? patch : {};
    if (source.progress && typeof source.progress === 'object') {
      book.progress = normalizeProgress(source.progress, book.progress);
      book.progressUpdatedAt = Number(source.progressUpdatedAt) || Date.now();
    }
    if (Number.isFinite(source.lastReadAt)) book.lastReadAt = source.lastReadAt;
    else book.lastReadAt = Date.now();
    this._writeNow();
    return book;
  }
}

module.exports = { Library, normalizeBook, normalizeProgress, LIBRARY_VERSION };
