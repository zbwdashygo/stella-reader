'use strict';

/**
 * EPUB 解析 / 解包 / 资源定位 / 全文搜索。
 *
 * 流程：
 *   epub(zip) → META-INF/container.xml → OPF
 *     → metadata(dc:title/creator/...)
 *     → manifest / spine
 *     → TOC（EPUB3 nav.xhtml 优先，回退 EPUB2 toc.ncx）
 *     → 封面（meta name=cover / properties=cover-image / guide / 文件名启发）
 *     → 解包到 <DATA_DIR>/books/<id>/（文本文件统一转 UTF-8 并改写 charset 声明）
 *     → 解析结果缓存到 <DATA_DIR>/meta/<id>.json
 *
 * 安全：
 *   - 解包时拒绝绝对路径 / 盘符 / 越出书目录的路径（zip slip）；
 *   - 资源读取同样做路径规范化 + 目录校验，越界返回 403。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AdmZip = require('adm-zip');

const { parseXml, textOf, childrenOf, findFirst, findAll, decodeEntities, htmlToText } = require('./xml');
const { decodeSmart, rewriteCharsetDecl, isTextExtension } = require('./encoding');

const META_VERSION = 1;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 30000;
const SEARCH_PER_CHAPTER_LIMIT = 5;
const SEARCH_DEFAULT_LIMIT = 50;
const SEARCH_CHAPTER_MAX_BYTES = 8 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif']);

class EpubError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'EpubError';
    this.code = code || 'EPUB_INVALID';
  }
}

/** EPUB 书 id：sha1(absPath.toLowerCase()).slice(0,16) */
function sha1Id(absPath) {
  return crypto.createHash('sha1').update(String(absPath).toLowerCase()).digest('hex').slice(0, 16);
}

/** 规范化 zip 内相对路径（posix 风格）；越出根目录返回 null。 */
function normalizeEpubPath(input) {
  let text = String(input == null ? '' : input)
    .replace(/\\/g, '/')
    .trim();
  if (!text) return '';
  text = text.replace(/^\.\/+/, '');
  text = text.replace(/^\/+/, '');
  // 去掉 URL 查询串 / 片段
  const hash = text.indexOf('#');
  if (hash >= 0) text = text.slice(0, hash);
  const query = text.indexOf('?');
  if (query >= 0) text = text.slice(0, query);
  const parts = [];
  for (const segment of text.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

function dirnamePosix(epubPath) {
  const normalized = String(epubPath || '').replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index === -1 ? '' : normalized.slice(0, index);
}

function isSafeChildPath(rootDir, targetPath) {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetPath);
  return target === root || target.startsWith(root + path.sep);
}

/**
 * 解析标签内的 href（相对当前目录），返回 epub 内规范路径 + fragment。
 */
function resolveHref(baseDir, href) {
  let raw = String(href == null ? '' : href).trim();
  if (!raw) return null;
  if (/^(?:[a-z][a-z0-9+.-]*:)/i.test(raw)) {
    // data: / http: 等外部协议不参与路径解析
    return null;
  }
  let fragment = '';
  const hashIndex = raw.indexOf('#');
  if (hashIndex >= 0) {
    fragment = raw.slice(hashIndex + 1);
    raw = raw.slice(0, hashIndex);
  }
  if (!raw) return null;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* 保留原样 */
  }
  const base = String(baseDir || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  const combined = raw.startsWith('/') ? raw : base ? `${base}/${raw}` : raw;
  const filePath = normalizeEpubPath(combined);
  if (filePath === null) return null;
  return { filePath, fragment };
}

/** 修正被 adm-zip 按 UTF-8 误解码的 zip 文件名（GBK 压缩包常见）。 */
function decodeZipName(entry) {
  try {
    const raw = entry.rawEntryName;
    if (Buffer.isBuffer(raw) && raw.length) {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(raw);
      } catch {
        /* 不是合法 UTF-8，尝试 GB18030 */
      }
      try {
        const gb = new TextDecoder('gb18030').decode(raw);
        if (gb && !gb.includes('\uFFFD')) return gb;
      } catch {
        /* 忽略 */
      }
    }
  } catch {
    /* 忽略 */
  }
  return String(entry.entryName || '');
}

/** 建立 zip 内路径 → entry 映射（含容错别名）。 */
function buildEntryMap(zip) {
  let entries;
  try {
    entries = zip.getEntries();
  } catch (error) {
    throw new EpubError(`无法读取 EPUB 压缩包：${error.message || error}`);
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new EpubError('EPUB 压缩包为空');
  }
  if (entries.length > MAX_ENTRIES) {
    throw new EpubError('EPUB 文件数量异常，已拒绝导入');
  }
  const map = new Map();
  for (const entry of entries) {
    if (!entry || entry.isDirectory) continue;
    const rawName = decodeZipName(entry);
    if (!rawName) continue;
    const normalized = normalizeEpubPath(rawName);
    if (!normalized) continue;
    if (!map.has(normalized)) map.set(normalized, entry);
  }
  return map;
}

/** 按路径取 entry，找不到时做一次大小写不敏感匹配。 */
function getEntry(entryMap, epubPath) {
  const normalized = normalizeEpubPath(epubPath);
  if (!normalized) return null;
  if (entryMap.has(normalized)) return entryMap.get(normalized);
  const lower = normalized.toLowerCase();
  for (const [key, entry] of entryMap) {
    if (key.toLowerCase() === lower) return entry;
  }
  return null;
}

function readEntryText(entryMap, epubPath) {
  const entry = getEntry(entryMap, epubPath);
  if (!entry) return null;
  let data;
  try {
    data = entry.getData();
  } catch {
    return null;
  }
  if (!data || !data.length) return '';
  return decodeSmart(data).text;
}

function tokenizeProperties(properties) {
  return String(properties || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((item) => item.toLowerCase());
}

function mediaTypeIsXhtml(mediaType, epubPath) {
  const type = String(mediaType || '').toLowerCase();
  if (type === 'application/xhtml+xml' || type === 'text/html' || type === 'application/html+xml') return true;
  const ext = path.extname(String(epubPath || '')).toLowerCase();
  return ext === '.xhtml' || ext === '.html' || ext === '.htm';
}

function isImageItem(item) {
  if (!item) return false;
  if (String(item.mediaType || '').startsWith('image/')) return true;
  return IMAGE_EXTENSIONS.has(path.extname(String(item.path || '')).toLowerCase());
}

function cleanTitle(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s·•\-–—]+|[\s·•\-–—]+$/g, '')
    .trim();
}

function basenameTitle(epubPath) {
  const name = path.posix.basename(String(epubPath || ''));
  const withoutExt = name.replace(/\.[a-z0-9]+$/i, '');
  return cleanTitle(withoutExt) || '未命名章节';
}

/* ------------------------------------------------------------------ */
/* OPF 解析                                                            */
/* ------------------------------------------------------------------ */

function parseMetadata(pkg) {
  const metadataNode = findFirst(pkg, (node) => node.name === 'metadata');
  const result = { title: '', creators: [], language: '', publisher: '', description: '', identifier: '', coverId: '' };
  if (!metadataNode) return result;

  const elements = findAll(metadataNode, () => true);
  const pickText = (names) => {
    for (const element of elements) {
      if (!names.includes(element.name)) continue;
      const value = textOf(element);
      if (value) return value;
    }
    return '';
  };

  // dc:title / dc:creator / dc:language / dc:publisher / dc:description / dc:identifier
  result.title = pickText(['title']);
  for (const element of elements) {
    if (element.name !== 'creator') continue;
    const value = textOf(element);
    if (value && !result.creators.includes(value)) result.creators.push(value);
  }
  result.language = pickText(['language']);
  result.publisher = pickText(['publisher']);
  result.identifier = pickText(['identifier']);

  const descriptionElement = elements.find((element) => element.name === 'description' && textOf(element));
  if (descriptionElement) {
    // dc:description 里常是转义后的 HTML，先解码再把标签去掉
    const decoded = descriptionElement.text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
    const stripped = decoded
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    result.description = stripped.slice(0, 4000);
  }

  // <meta name="cover" content="cover-image-id" />
  for (const element of elements) {
    if (element.name !== 'meta') continue;
    if (String(element.attrs.name || '').toLowerCase() === 'cover' && element.attrs.content) {
      result.coverId = String(element.attrs.content).trim();
      break;
    }
  }
  return result;
}

function parseManifest(pkg, opfDir) {
  const manifestNode = findFirst(pkg, (node) => node.name === 'manifest');
  const items = [];
  const byId = new Map();
  if (!manifestNode) return { items, byId };
  for (const element of childrenOf(manifestNode)) {
    if (element.name !== 'item') continue;
    const rawHref = String(element.attrs.href || '').trim();
    const resolved = rawHref ? resolveHref(opfDir, rawHref) : null;
    const item = {
      id: String(element.attrs.id || ''),
      href: rawHref,
      path: resolved ? resolved.filePath : '',
      mediaType: String(element.attrs['media-type'] || '').toLowerCase(),
      properties: String(element.attrs.properties || '')
    };
    items.push(item);
    if (item.id) byId.set(item.id, item);
  }
  return { items, byId };
}

function parseSpine(pkg, manifest, entryMap) {
  const spineNode = findFirst(pkg, (node) => node.name === 'spine');
  const spine = [];
  if (spineNode) {
    for (const element of childrenOf(spineNode)) {
      if (element.name !== 'itemref') continue;
      const idref = String(element.attrs.idref || '');
      const item = manifest.byId.get(idref);
      if (!item || !item.path) continue;
      if (getEntry(entryMap, item.path) == null) continue;
      spine.push({ path: item.path, title: '', idref, mediaType: item.mediaType });
    }
  }
  // 没有可用 itemref 时，退化为按 manifest 顺序取所有 xhtml
  if (!spine.length) {
    for (const item of manifest.items) {
      if (!item.path || !mediaTypeIsXhtml(item.mediaType, item.path)) continue;
      if (getEntry(entryMap, item.path) == null) continue;
      spine.push({ path: item.path, title: '', idref: item.id, mediaType: item.mediaType });
    }
  }
  return { spine, spineNode };
}

/* ------------------------------------------------------------------ */
/* TOC                                                                 */
/* ------------------------------------------------------------------ */

function parseNavList(listNode, depth, baseDir) {
  if (!listNode) return [];
  const output = [];
  for (const li of childrenOf(listNode)) {
    if (li.name !== 'li') continue;
    const directChildren = childrenOf(li);
    const anchor =
      directChildren.find((node) => node.name === 'a') ||
      directChildren.find((node) => node.name === 'span') ||
      findFirst(li, (node) => node.name === 'a' || node.name === 'span');
    const title = anchor ? cleanTitle(textOf(anchor)) : '';
    const href = anchor && anchor.attrs.href ? String(anchor.attrs.href) : '';
    const nestedList = directChildren.find((node) => node.name === 'ol' || node.name === 'ul');
    const children = nestedList ? parseNavList(nestedList, depth + 1, baseDir) : [];

    if (!title && children.length) {
      // 纯分组节点：把子项提升上来，避免目录层级断裂
      output.push(...children);
      continue;
    }
    if (!title) continue;

    const item = { title, depth };
    const resolved = href ? resolveHref(baseDir, href) : null;
    if (resolved && resolved.filePath) {
      item.path = resolved.fragment ? `${resolved.filePath}#${resolved.fragment}` : resolved.filePath;
      item.href = item.path;
      if (resolved.fragment) item.fragment = resolved.fragment;
    }
    if (children.length) item.children = children;
    output.push(item);
  }
  return output;
}

function parseNavToc(text, navPath) {
  const doc = parseXml(text);
  const navs = findAll(doc, (node) => node.name === 'nav');
  if (!navs.length) return [];
  let nav = navs.find((node) => tokenizeProperties(node.attrs.type).includes('toc'));
  if (!nav) nav = navs[0];
  const baseDir = dirnamePosix(navPath);
  let listNode = childrenOf(nav).find((node) => node.name === 'ol' || node.name === 'ul');
  if (!listNode) listNode = findFirst(nav, (node) => node.name === 'ol' || node.name === 'ul');
  if (!listNode) return [];
  return parseNavList(listNode, 0, baseDir);
}

function parseNavPoints(navPoints, depth, baseDir) {
  const output = [];
  for (const point of navPoints) {
    const labelNode = findFirst(point, (node) => node.name === 'navlabel');
    const textNode = labelNode ? findFirst(labelNode, (node) => node.name === 'text') : null;
    const title = cleanTitle(textNode ? textOf(textNode) : '');
    const contentNode =
      childrenOf(point).find((node) => node.name === 'content') || findFirst(point, (node) => node.name === 'content');
    const src = contentNode && contentNode.attrs.src ? String(contentNode.attrs.src) : '';
    const childPoints = childrenOf(point).filter((node) => node.name === 'navpoint');
    const children = childPoints.length ? parseNavPoints(childPoints, depth + 1, baseDir) : [];
    if (!title && children.length) {
      output.push(...children);
      continue;
    }
    if (!title) continue;
    const item = { title, depth };
    const resolved = src ? resolveHref(baseDir, src) : null;
    if (resolved && resolved.filePath) {
      item.path = resolved.fragment ? `${resolved.filePath}#${resolved.fragment}` : resolved.filePath;
      item.href = item.path;
      if (resolved.fragment) item.fragment = resolved.fragment;
    }
    if (children.length) item.children = children;
    output.push(item);
  }
  return output;
}

function parseNcxToc(text, ncxPath) {
  const doc = parseXml(text);
  const navMap = findFirst(doc, (node) => node.name === 'navmap');
  if (!navMap) return [];
  const baseDir = dirnamePosix(ncxPath);
  const points = childrenOf(navMap).filter((node) => node.name === 'navpoint');
  return parseNavPoints(points, 0, baseDir);
}

function flattenToc(toc) {
  const output = [];
  const walk = (items) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      output.push(item);
      if (item.children) walk(item.children);
    }
  };
  walk(toc);
  return output;
}

function flattenTocTitles(toc) {
  const map = new Map();
  for (const item of flattenToc(toc)) {
    if (!item.path) continue;
    const filePath = item.path.split('#')[0];
    if (!map.has(filePath)) map.set(filePath, item.title);
  }
  return map;
}

function parseToc({ pkg, manifest, spine, spineNode, entryMap, opfDir }) {
  let toc = [];
  let tocSource = 'none';

  // 1) EPUB3 nav
  const navItem =
    manifest.items.find((item) => item.path && tokenizeProperties(item.properties).includes('nav')) ||
    manifest.items.find((item) => item.path && /(^|\/)nav\.x?html?$/i.test(item.path));
  if (navItem && navItem.path) {
    const text = readEntryText(entryMap, navItem.path);
    if (text) {
      try {
        toc = parseNavToc(text, navItem.path);
        if (toc.length) tocSource = 'nav';
      } catch (error) {
        console.error('[epub] nav.xhtml 解析失败，尝试 NCX：', error.message);
        toc = [];
      }
    }
  }

  // 2) EPUB2 NCX
  if (!toc.length) {
    let ncxItem = null;
    const tocId = spineNode && spineNode.attrs ? String(spineNode.attrs.toc || '') : '';
    if (tocId) ncxItem = manifest.byId.get(tocId) || null;
    if (!ncxItem || !ncxItem.path) {
      ncxItem = manifest.items.find((item) => String(item.mediaType || '').includes('dtbncx')) || null;
    }
    if (!ncxItem || !ncxItem.path) {
      const ncxPath = [...entryMap.keys()].find((key) => key.toLowerCase().endsWith('.ncx'));
      if (ncxPath) {
        const text = readEntryText(entryMap, ncxPath);
        if (text) {
          try {
            toc = parseNcxToc(text, ncxPath);
            if (toc.length) tocSource = 'ncx';
          } catch (error) {
            console.error('[epub] NCX 解析失败：', error.message);
          }
        }
      }
    } else {
      const text = readEntryText(entryMap, ncxItem.path);
      if (text) {
        try {
          toc = parseNcxToc(text, ncxItem.path);
          if (toc.length) tocSource = 'ncx';
        } catch (error) {
          console.error('[epub] NCX 解析失败：', error.message);
        }
      }
    }
  }

  // 3) 兜底：用 spine 生成一级目录
  if (!toc.length) {
    toc = spine.map((item) => ({ title: basenameTitle(item.path), path: item.path, depth: 0 }));
    tocSource = 'spine';
  }

  // 给 spine 补 title（TOC 中出现过该文件的标题优先）
  const titleMap = flattenTocTitles(toc);
  spine.forEach((item, index) => {
    item.title = titleMap.get(item.path) || basenameTitle(item.path) || `第 ${index + 1} 章`;
  });

  return { toc, tocSource };
}

/* ------------------------------------------------------------------ */
/* 封面                                                                */
/* ------------------------------------------------------------------ */

function firstImageSrc(xhtml) {
  const text = String(xhtml || '');
  let match = text.match(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
  if (match) return match[1] || match[2] || match[3] || '';
  match = text.match(/<(?:image|svg:image)\b[^>]*?\b(?:xlink:)?href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
  if (match) return match[1] || match[2] || match[3] || '';
  return '';
}

function resolveCover(pkg, metadata, manifest, entryMap, opfDir) {
  const hasImage = (epubPath) => Boolean(epubPath) && getEntry(entryMap, epubPath) != null;

  // 1) <meta name="cover" content="id" />
  if (metadata.coverId) {
    const item = manifest.byId.get(metadata.coverId);
    if (item && item.path && isImageItem(item) && hasImage(item.path)) return item.path;
    // content 偶尔直接是 href 而非 id
    const resolved = resolveHref(opfDir, metadata.coverId);
    if (resolved && resolved.filePath && hasImage(resolved.filePath)) return resolved.filePath;
  }

  // 2) EPUB3 properties="cover-image"
  const propertyItem = manifest.items.find(
    (item) => item.path && hasImage(item.path) && tokenizeProperties(item.properties).includes('cover-image')
  );
  if (propertyItem) return propertyItem.path;

  // 3) guide <reference type="cover" href="..."/>
  const guideNode = findFirst(pkg, (node) => node.name === 'guide');
  if (guideNode) {
    const reference = childrenOf(guideNode).find(
      (node) => node.name === 'reference' && String(node.attrs.type || '').toLowerCase() === 'cover'
    );
    if (reference && reference.attrs.href) {
      const resolved = resolveHref(opfDir, reference.attrs.href);
      if (resolved && resolved.filePath && hasImage(resolved.filePath)) {
        if (IMAGE_EXTENSIONS.has(path.extname(resolved.filePath).toLowerCase())) return resolved.filePath;
        const pageText = readEntryText(entryMap, resolved.filePath);
        const imageSrc = pageText ? firstImageSrc(pageText) : '';
        if (imageSrc) {
          const imageResolved = resolveHref(dirnamePosix(resolved.filePath), imageSrc);
          if (imageResolved && imageResolved.filePath && hasImage(imageResolved.filePath)) {
            return imageResolved.filePath;
          }
        }
      }
    }
  }

  // 4) 文件名启发式
  const heuristic = manifest.items.find(
    (item) =>
      item.path &&
      hasImage(item.path) &&
      isImageItem(item) &&
      /(^|\/)(?:cover|front[-_]?cover|cover[-_]?image)\.(?:png|jpe?g|gif|webp|svg|bmp)$/i.test(item.path)
  );
  return heuristic ? heuristic.path : null;
}

/* ------------------------------------------------------------------ */
/* 解包                                                                */
/* ------------------------------------------------------------------ */

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = JSON.stringify(value, null, 2);
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmpFile, payload, 'utf8');
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      fs.renameSync(tmpFile, filePath);
      return;
    } catch (error) {
      lastError = error;
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
      } catch {
        /* 忽略 */
      }
    }
  }
  fs.writeFileSync(filePath, payload, 'utf8');
  try {
    fs.unlinkSync(tmpFile);
  } catch {
    /* 忽略 */
  }
  if (lastError) console.error('[epub] meta 原子写失败，已直接写入：', lastError.message);
}

function extractEntries(entryMap, destDir) {
  const parentDir = path.dirname(destDir);
  fs.mkdirSync(parentDir, { recursive: true });
  const tmpDir = path.join(
    parentDir,
    `.${path.basename(destDir)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  let totalBytes = 0;
  try {
    for (const [relativePath, entry] of entryMap) {
      const target = path.resolve(tmpDir, relativePath);
      if (!isSafeChildPath(tmpDir, target)) continue; // zip slip：直接跳过
      let data;
      try {
        data = entry.getData();
      } catch (error) {
        throw new EpubError(`EPUB 内文件解压失败（${relativePath}）：${error.message || error}`);
      }
      totalBytes += data.length;
      if (totalBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
        throw new EpubError('EPUB 解包后体积过大，已拒绝导入');
      }
      const extension = path.extname(relativePath).toLowerCase();
      let output = data;
      if (isTextExtension(extension)) {
        // 统一转 UTF-8，并改写文件内的 charset 声明
        const decoded = decodeSmart(data);
        output = Buffer.from(rewriteCharsetDecl(decoded.text), 'utf8');
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, output);
    }

    fs.rmSync(destDir, { recursive: true, force: true });
    try {
      fs.renameSync(tmpDir, destDir);
    } catch {
      // 跨设备 / 目标被占用时退化为复制
      fs.cpSync(tmpDir, destDir, { recursive: true });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch (error) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }
  return { fileCount: entryMap.size, totalBytes };
}

/* ------------------------------------------------------------------ */
/* 导入（解析 + 解包 + 写 meta）                                        */
/* ------------------------------------------------------------------ */

function buildMetaPath(dataDir, id) {
  return path.join(dataDir, 'meta', `${id}.json`);
}

/**
 * 导入一本 EPUB：解析 → 解包 → 写 meta。
 * 失败会抛 EpubError，调用方转成 400。
 *
 * @param {{ filePath: string, dataDir: string, id?: string }} options
 */
function ingest(options) {
  const { filePath, dataDir, id: providedId } = options || {};
  if (!filePath) throw new EpubError('缺少 EPUB 文件路径');
  const absPath = path.resolve(filePath);
  const id = providedId || sha1Id(absPath);

  let zip;
  try {
    zip = new AdmZip(absPath);
  } catch (error) {
    throw new EpubError(`无法打开 EPUB 文件（可能已损坏或不是 zip）：${error.message || error}`);
  }

  try {
    let entryMap;
    try {
      entryMap = buildEntryMap(zip);
    } catch (error) {
      if (error instanceof EpubError) throw error;
      throw new EpubError(`无法读取 EPUB 压缩包：${error.message || error}`);
    }

    const containerText = readEntryText(entryMap, 'META-INF/container.xml');
    let opfPath = '';
    if (containerText) {
      const containerDoc = parseXml(containerText);
      const rootfile = findFirst(containerDoc, (node) => node.name === 'rootfile');
      if (rootfile && rootfile.attrs && rootfile.attrs['full-path']) {
        const resolved = resolveHref('', rootfile.attrs['full-path']);
        if (resolved && resolved.filePath && getEntry(entryMap, resolved.filePath)) {
          opfPath = resolved.filePath;
        }
      }
    }
    if (!opfPath) {
      opfPath = [...entryMap.keys()].find((key) => key.toLowerCase().endsWith('.opf')) || '';
    }
    if (!opfPath) {
      throw new EpubError('EPUB 缺少 OPF 文件（META-INF/container.xml 无效）');
    }

    const opfText = readEntryText(entryMap, opfPath);
    if (!opfText) throw new EpubError('EPUB 的 OPF 文件读取失败或为空');

    const opfDoc = parseXml(opfText);
    const pkg = findFirst(opfDoc, (node) => node.name === 'package') || opfDoc;
    const opfDir = dirnamePosix(opfPath);
    const metadata = parseMetadata(pkg);
    const manifest = parseManifest(pkg, opfDir);
    if (!manifest.items.length) throw new EpubError('EPUB 缺少 manifest 内容');

    const { spine, spineNode } = parseSpine(pkg, manifest, entryMap);
    if (!spine.length) throw new EpubError('EPUB 没有可阅读的章节（spine 为空或章节文件缺失）');

    const { toc, tocSource } = parseToc({ pkg, manifest, spine, spineNode, entryMap, opfDir });
    const coverHref = resolveCover(pkg, metadata, manifest, entryMap, opfDir);

    const destDir = path.join(dataDir, 'books', id);
    const extraction = extractEntries(entryMap, destDir);

    const meta = {
      version: META_VERSION,
      id,
      path: absPath,
      opfPath,
      opfDir,
      spine,
      toc,
      tocSource,
      coverHref: coverHref || null,
      fileCount: extraction.fileCount,
      totalBytes: extraction.totalBytes,
      generatedAt: Date.now()
    };
    writeJsonAtomic(buildMetaPath(dataDir, id), meta);

    const summary = {
      title: metadata.title || path.basename(absPath, path.extname(absPath)) || '未命名书籍',
      author: metadata.creators.length ? metadata.creators.slice(0, 3).join('、') : '未知作者',
      publisher: metadata.publisher || undefined,
      language: metadata.language || undefined,
      description: metadata.description || undefined,
      cover: coverHref ? `/api/books/${id}/cover` : undefined,
      spineCount: spine.length,
      tocSource
    };
    return { id, path: absPath, meta, summary, metadata };
  } finally {
    // adm-zip 没有 close()，释放引用即可
    zip = null;
  }
}

/** 读取已缓存的解析结果；不存在或损坏返回 null。 */
function loadMeta(dataDir, id) {
  const file = buildMetaPath(dataDir, id);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const meta = JSON.parse(raw);
    if (!meta || !Array.isArray(meta.spine) || !Array.isArray(meta.toc)) return null;
    return meta;
  } catch {
    return null;
  }
}

function clearBookCache(dataDir, id) {
  const dirs = [path.join(dataDir, 'books', id), path.join(dataDir, 'meta', `${id}.json`)];
  for (const target of dirs) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (error) {
      console.error('[epub] 清理缓存失败：', target, error.message);
    }
  }
}

/**
 * 把 epub 内相对路径解析为缓存目录中的绝对文件路径。
 * @returns {{ status: 200|403|404, file?: string }}
 */
function resolveBookFile(dataDir, id, relativePath) {
  const normalized = normalizeEpubPath(relativePath);
  if (!normalized) return { status: 403 };
  const rootDir = path.join(dataDir, 'books', id);
  const target = path.resolve(rootDir, normalized);
  if (!isSafeChildPath(rootDir, target) || target === path.resolve(rootDir)) {
    return { status: 403 };
  }
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile()) return { status: 404 };
    return { status: 200, file: target };
  } catch {
    return { status: 404 };
  }
}

/* ------------------------------------------------------------------ */
/* 全文搜索                                                            */
/* ------------------------------------------------------------------ */

function buildSnippet(text, index, queryLength) {
  const before = 60;
  const after = 60;
  const start = Math.max(0, index - before);
  const end = Math.min(text.length, index + queryLength + after);
  const body = text.slice(start, end);
  const relative = index - start;
  const prefix = start > 0 ? '……' : '';
  const suffix = end < text.length ? '……' : '';
  return (
    prefix +
    body.slice(0, relative) +
    '<mark>' +
    body.slice(relative, relative + queryLength) +
    '</mark>' +
    body.slice(relative + queryLength) +
    suffix
  );
}

/** 这些标签在纯文本中转换为空格，避免相邻块文字粘连。 */
const BLOCK_TAGS = new Set([
  'p', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'td', 'th',
  'blockquote', 'section', 'article', 'header', 'footer', 'pre', 'figure', 'figcaption',
  'table', 'dd', 'dt', 'br', 'hr', 'body', 'html', 'img', 'aside', 'main', 'nav'
]);

/**
 * 把 HTML/XHTML 转成纯文本，同时记录每个纯文本字符对应的原始 HTML 下标。
 * 用于按 TOC 锚点位置判断某条搜索结果属于哪个章节（同一文件含多章时）。
 * @returns {{ text: string, map: number[] }}
 */
function buildPlainTextWithIndex(html) {
  const raw = String(html == null ? '' : html);
  const chars = [];
  const map = [];
  const pushChar = (char, rawIndex) => {
    const normalized = char === '\u00a0' ? ' ' : char;
    if (/\s/.test(normalized)) {
      if (!chars.length || chars[chars.length - 1] === ' ') return;
      chars.push(' ');
      map.push(rawIndex);
      return;
    }
    chars.push(normalized);
    map.push(rawIndex);
  };
  const pushText = (segment, startIndex) => {
    let k = 0;
    while (k < segment.length) {
      if (segment[k] === '&') {
        const match = /^&(?:#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]+);/.exec(segment.slice(k));
        if (match) {
          for (const char of decodeEntities(match[0])) pushChar(char, startIndex + k);
          k += match[0].length;
          continue;
        }
      }
      pushChar(segment[k], startIndex + k);
      k += 1;
    }
  };

  let i = 0;
  const n = raw.length;
  while (i < n) {
    if (raw.startsWith('<!--', i)) {
      const end = raw.indexOf('-->', i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (raw[i] !== '<') {
      const nextTag = raw.indexOf('<', i);
      const end = nextTag === -1 ? n : nextTag;
      pushText(raw.slice(i, end), i);
      i = end;
      continue;
    }
    // 标签：找到不受引号包裹的 '>'
    let j = i + 1;
    let quote = null;
    for (; j < n; j += 1) {
      const char = raw[j];
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        break;
      }
    }
    if (j >= n) break;
    const body = raw.slice(i + 1, j);
    const nameMatch = body.match(/^\s*\/?\s*([A-Za-z][A-Za-z0-9:-]*)/);
    const tagName = nameMatch ? nameMatch[1].toLowerCase() : '';
    const isClosing = /^\s*\//.test(body);
    if (!isClosing && (tagName === 'script' || tagName === 'style' || tagName === 'head')) {
      const closeMatch = new RegExp('</\\s*' + tagName + '\\s*>', 'i').exec(raw.slice(j + 1));
      if (closeMatch) {
        i = j + 1 + closeMatch.index + closeMatch[0].length;
        continue;
      }
      i = n;
      break;
    }
    if (BLOCK_TAGS.has(tagName)) pushChar(' ', i);
    i = j + 1;
  }

  let start = 0;
  let end = chars.length;
  while (start < end && chars[start] === ' ') start += 1;
  while (end > start && chars[end - 1] === ' ') end -= 1;
  return { text: chars.slice(start, end).join(''), map: map.slice(start, end) };
}

/**
 * 建立「章节文件路径 → TOC 候选标题」索引，保留 depth / fragment / 出现顺序。
 */
function buildTocTitleCandidates(toc) {
  const index = new Map();
  const walk = (items) => {
    for (const item of items || []) {
      if (!item) continue;
      if (item.path && item.title) {
        const hashIndex = item.path.indexOf('#');
        const filePath = hashIndex === -1 ? item.path : item.path.slice(0, hashIndex);
        const fragment = hashIndex === -1 ? item.fragment || '' : item.path.slice(hashIndex + 1);
        let list = index.get(filePath);
        if (!list) {
          list = [];
          index.set(filePath, list);
        }
        list.push({
          title: item.title,
          depth: typeof item.depth === 'number' ? item.depth : 0,
          fragment,
          order: list.length
        });
      }
      if (item.children) walk(item.children);
    }
  };
  walk(toc);
  return index;
}

/** 在原始 HTML 中查找 TOC 锚点（id/name=fragment）的位置；找不到返回 -1。 */
function findTocAnchorIndex(rawHtml, fragment) {
  if (!fragment) return -1;
  const values = [fragment];
  try {
    const decoded = decodeURIComponent(fragment);
    if (decoded !== fragment) values.push(decoded);
  } catch {
    /* 忽略非法编码 */
  }
  for (const value of values) {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp('(?:id|name)\\s*=\\s*(["\'])' + escaped + '\\1', 'i').exec(rawHtml);
    if (match) return match.index;
  }
  return -1;
}

/** 章节级标题特征：2=标题以 Chapter/第N章 等开头，1=标题中出现，0=不是章节标题。 */
const CHAPTER_TITLE_START = [
  /^\s*(?:chapter|chap\.?|part|book)\b/i,
  /^\s*第\s*[0-9一二三四五六七八九十百零〇两]+\s*[章节回卷部篇]/,
  /^\s*(?:序章|楔子|引子|尾声|后记|前言|序言|番外)/
];
const CHAPTER_TITLE_CONTAINS = [
  /\bchapter\s+[ivxlcdm\d]+/i,
  /第\s*[0-9一二三四五六七八九十百零〇两]+\s*[章节回卷部篇]/
];

function chapterLikeLevel(title) {
  const value = String(title || '');
  if (CHAPTER_TITLE_START.some((pattern) => pattern.test(value))) return 2;
  if (CHAPTER_TITLE_CONTAINS.some((pattern) => pattern.test(value))) return 1;
  return 0;
}

/**
 * 规范化搜索结果的章节标题（只影响 search 的 chapterTitle 字段）。
 * 部分 EPUB（如 Gutenberg NCX）把上一章正文最后一句话拼进了下一章标题，
 * 例如 "He rode a black horse. CHAPTER III."，这里截取章节标记起始部分，
 * 让结果列表统一显示为 "CHAPTER III."。
 */
function normalizeSearchChapterTitle(title) {
  const value = String(title || '').trim();
  if (!value) return value;
  const match = /\bchapter\s+[ivxlcdm\d]+/i.exec(value);
  if (match && match.index > 0) {
    return value.slice(match.index).replace(/^[\s"'“”‘’·•\-–—.,;:]+/, '').trim() || value;
  }
  return value;
}

/**
 * 从同一章节文件的多个 TOC 标题里挑选最贴近当前命中位置的章节标题。
 * - 先只看 depth 最大的（叶子层级），避免部级标题盖住章节标题；
 * - 有锚点且知道命中位置：取命中位置之前最近的锚点标题；
 * - 若选中项不是章节级标题（如英文书名页标题），改用最近的章节级标题；
 * - 无锚点/无法定位：取 depth 最大、章节特征最强的标题；
 * - 都没有：回退 spine 标题 / 文件名。
 */
function chooseChapterTitle(candidates, rawHtml, rawOffset, fallbackTitle) {
  if (!candidates || !candidates.length) return fallbackTitle;

  const maxDepth = Math.max(...candidates.map((candidate) => candidate.depth));
  const pool = candidates.filter((candidate) => candidate.depth === maxDepth);

  const positioned = [];
  for (const candidate of pool) {
    const position = findTocAnchorIndex(rawHtml, candidate.fragment);
    if (position >= 0) positioned.push({ candidate, position });
  }

  if (positioned.length && rawOffset >= 0) {
    const before = positioned.filter((entry) => entry.position <= rawOffset);
    const nearest = before.length
      ? before.sort((a, b) => b.position - a.position)[0]
      : positioned.sort((a, b) => a.position - b.position)[0];
    if (chapterLikeLevel(nearest.candidate.title) > 0) return nearest.candidate.title || fallbackTitle;

    // 命中在书名页/序言等非章节标题区域：优先显示最近的章节级标题
    const chapterCandidates = positioned
      .filter((entry) => chapterLikeLevel(entry.candidate.title) > 0)
      .sort((a, b) => {
        const distance = Math.abs(a.position - rawOffset) - Math.abs(b.position - rawOffset);
        if (distance !== 0) return distance;
        if (a.position > rawOffset !== b.position > rawOffset) return a.position > rawOffset ? 1 : -1;
        return chapterLikeLevel(b.candidate.title) - chapterLikeLevel(a.candidate.title);
      });
    if (chapterCandidates.length) return chapterCandidates[0].candidate.title || fallbackTitle;
    return nearest.candidate.title || fallbackTitle;
  }

  const sorted = [...pool].sort((a, b) => {
    const levelDiff = chapterLikeLevel(b.title) - chapterLikeLevel(a.title);
    if (levelDiff !== 0) return levelDiff;
    if (b.depth !== a.depth) return b.depth - a.depth;
    return a.order - b.order;
  });
  return sorted[0].title || fallbackTitle;
}

/**
 * 跨章全文搜索（去 HTML 标签后匹配，最多 limit 条）。
 * snippet 为纯文本 + <mark> 包裹命中词，其余转义由前端负责。
 *
 * chapterTitle 选择策略：同一个章节文件在 TOC 里可能对应多条（如部级标题 +
 * 章节标题，或英文一本书一个文件含多章）。优先取「在正文中位于命中位置之前、
 * 且离命中位置最近」的 TOC 锚点标题；无法按锚点定位时取 depth 最大的叶子标题。
 */
function searchBook(dataDir, meta, query, options) {
  const rawQuery = String(query == null ? '' : query).trim();
  const limit = Math.max(1, Math.min(Number((options && options.limit) || SEARCH_DEFAULT_LIMIT) || 50, 200));
  if (!rawQuery) return [];
  const needle = rawQuery.toLowerCase();
  const results = [];
  const tocTitleIndex = buildTocTitleCandidates(meta.toc);

  for (let spineIndex = 0; spineIndex < meta.spine.length; spineIndex += 1) {
    if (results.length >= limit) break;
    const spineItem = meta.spine[spineIndex];
    if (!spineItem || !spineItem.path) continue;
    const resolved = resolveBookFile(dataDir, meta.id, spineItem.path);
    if (resolved.status !== 200) continue;

    let text = '';
    try {
      const stat = fs.statSync(resolved.file);
      if (stat.size > SEARCH_CHAPTER_MAX_BYTES) continue;
      text = decodeSmart(fs.readFileSync(resolved.file)).text;
    } catch {
      continue;
    }

    const candidates = tocTitleIndex.get(spineItem.path) || [];
    // 只有一个候选 / 没有可定位的锚点时不需要构建「纯文本→原始 HTML」下标映射
    const needsAnchorMap = candidates.filter((candidate) => candidate.fragment).length > 1;
    let plain;
    let indexMap = null;
    if (needsAnchorMap) {
      const built = buildPlainTextWithIndex(text);
      plain = built.text;
      indexMap = built.map;
    } else {
      plain = htmlToText(text);
    }
    if (!plain) continue;

    const fallbackTitle = spineItem.title || basenameTitle(spineItem.path);
    const lower = plain.toLowerCase();
    let from = 0;
    let found = 0;
    while (found < SEARCH_PER_CHAPTER_LIMIT && results.length < limit) {
      const index = lower.indexOf(needle, from);
      if (index < 0) break;

      let rawOffset = -1;
      if (indexMap) {
        for (let k = index; k < indexMap.length; k += 1) {
          if (indexMap[k] >= 0) {
            rawOffset = indexMap[k];
            break;
          }
        }
      }
      const chosenTitle = chooseChapterTitle(candidates, text, rawOffset, fallbackTitle);

      results.push({
        spineIndex,
        path: spineItem.path,
        chapterTitle: normalizeSearchChapterTitle(chosenTitle),
        snippet: buildSnippet(plain, index, rawQuery.length)
      });
      found += 1;
      from = index + Math.max(1, needle.length);
    }
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* Content-Type                                                        */
/* ------------------------------------------------------------------ */

const SIMPLE_MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.ncx': 'application/xml; charset=utf-8',
  '.opf': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml; charset=utf-8',
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
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
};

/**
 * 根据扩展名 + 内容推断 Content-Type。
 * xhtml/html：有 xmlns 声明时 application/xhtml+xml，否则 text/html（与 API.md 一致）。
 */
function contentTypeFor(filePath, buffer) {
  const extension = path.extname(String(filePath || '')).toLowerCase();
  if (extension === '.xhtml' || extension === '.xht' || extension === '.html' || extension === '.htm') {
    const head = buffer ? Buffer.from(buffer).subarray(0, 4096).toString('utf8') : '';
    const hasXmlns = /xmlns\s*=/i.test(head);
    return hasXmlns ? 'application/xhtml+xml; charset=utf-8' : 'text/html; charset=utf-8';
  }
  return SIMPLE_MIME[extension] || 'application/octet-stream';
}

module.exports = {
  EpubError,
  sha1Id,
  normalizeEpubPath,
  resolveHref,
  ingest,
  loadMeta,
  clearBookCache,
  resolveBookFile,
  searchBook,
  contentTypeFor,
  flattenToc,
  buildMetaPath
};
