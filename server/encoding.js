'use strict';

/**
 * 文本编码识别与转码。
 *
 * EPUB 现实情况：
 *  - 大多数是 UTF-8；
 *  - 中文老书常见 GBK / GB2312 / GB18030，且可能在 XML 声明或 <meta charset> 里写着；
 *  - 也有声明缺失、但实际是 GBK 的；
 *  - 少量西文 EPUB 用 windows-1252。
 *
 * 目标：统一解码成 JS 字符串（UTF-8 语义），并在写回缓存前把文件内的
 * charset / encoding 声明改写成 utf-8，保证浏览器拿到的是 UTF-8。
 */

const LEGACY_GB = new Set([
  'gb2312',
  'gbk',
  'gb18030',
  'gb_2312',
  'gb-2312',
  'gb2312-80',
  'x-gbk',
  'cp936',
  'windows-936',
  'euc-cn',
  'hz-gb-2312'
]);

const LEGACY_LATIN = new Set(['windows-1252', 'cp1252', 'latin1', 'iso-8859-1', 'iso8859-1', 'us-ascii', 'ascii']);

const TEXT_EXTENSIONS = new Set([
  '.xhtml',
  '.xht',
  '.html',
  '.htm',
  '.xml',
  '.opf',
  '.ncx',
  '.css',
  '.svg',
  '.js',
  '.txt'
]);

function normalizeCharset(charset) {
  return String(charset || '')
    .trim()
    .toLowerCase()
    .replace(/^["']|["']$/g, '');
}

function isLegacyCharset(charset) {
  const normalized = normalizeCharset(charset);
  return LEGACY_GB.has(normalized) || LEGACY_LATIN.has(normalized);
}

function tryDecode(label, buffer, fatal) {
  try {
    return new TextDecoder(label, fatal ? { fatal: true } : undefined).decode(buffer);
  } catch {
    return null;
  }
}

function countReplacement(text) {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 0xfffd) count += 1;
  }
  return count;
}

function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 从文件头部探测声明的编码。
 * @param {Buffer} buffer
 * @returns {string} 原始声明值（小写），未声明返回 ''
 */
function detectDeclaredCharset(buffer) {
  const head = buffer.subarray(0, 4096).toString('latin1');
  let match = head.match(/<\?xml[^>]*?encoding\s*=\s*["']([^"']+)["']/i);
  if (match) return normalizeCharset(match[1]);
  match = head.match(/charset\s*=\s*["']?\s*([A-Za-z0-9_.:\-]+)/i);
  if (match) return normalizeCharset(match[1]);
  match = head.match(/@charset\s+["']([^"']+)["']/i);
  if (match) return normalizeCharset(match[1]);
  return '';
}

function looksLikeGb(text) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text);
}

/**
 * 智能解码任意文本字节。
 * @param {Buffer|Uint8Array} buffer
 * @returns {{ text: string, encoding: string, declared: string, converted: boolean }}
 */
function decodeSmart(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);

  // 1) BOM 优先
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xfe && buf[2] === 0x00 && buf[3] === 0x00) {
    return {
      text: stripBom(tryDecode('utf-32le', buf.subarray(4)) || buf.subarray(4).toString('utf8')),
      encoding: 'utf-32le',
      declared: '',
      converted: true
    };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return {
      text: stripBom(tryDecode('utf-16le', buf.subarray(2)) || buf.subarray(2).toString('utf8')),
      encoding: 'utf-16le',
      declared: '',
      converted: true
    };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return {
      text: stripBom(tryDecode('utf-16be', buf.subarray(2)) || buf.subarray(2).toString('utf8')),
      encoding: 'utf-16be',
      declared: '',
      converted: true
    };
  }
  const hadUtf8Bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const payload = hadUtf8Bom ? buf.subarray(3) : buf;
  const declared = detectDeclaredCharset(buf);

  // 2) 合法 UTF-8 直接使用（声明写错的情况也以实际字节为准）
  const utf8 = tryDecode('utf-8', payload, true);
  if (utf8 !== null) {
    return {
      text: stripBom(utf8),
      encoding: 'utf-8',
      declared,
      converted: hadUtf8Bom && declared !== 'utf-8'
    };
  }

  // 3) 声明是 GB 系列
  if (LEGACY_GB.has(declared) || declared === 'gb18030') {
    const gb = tryDecode('gb18030', payload, false);
    if (gb !== null) {
      return { text: stripBom(gb), encoding: 'gb18030', declared, converted: true };
    }
  }

  // 4) 未声明或声明不可用时按字节猜：GB18030 能解出中文且无替换字符则采用
  const gb = tryDecode('gb18030', payload, false);
  if (gb !== null) {
    const bad = countReplacement(gb);
    if (bad === 0 && looksLikeGb(gb)) {
      return { text: stripBom(gb), encoding: 'gb18030', declared, converted: true };
    }
  }

  // 5) 西文兜底：windows-1252
  if (LEGACY_LATIN.has(declared) || declared === '') {
    const latin = tryDecode('windows-1252', payload, false);
    if (latin !== null && countReplacement(latin) === 0) {
      return { text: stripBom(latin), encoding: 'windows-1252', declared, converted: declared !== 'windows-1252' };
    }
  }

  // 6) 最后用 UTF-8 宽松解码（会有替换字符，但服务不崩）
  return {
    text: stripBom(tryDecode('utf-8', payload, false) || payload.toString('utf8')),
    encoding: 'utf-8-lossy',
    declared,
    converted: true
  };
}

/**
 * 把文本里的 charset / encoding 声明改写为 utf-8。
 * 因为我们写回缓存时统一使用 UTF-8 编码。
 */
function rewriteCharsetDecl(text) {
  let out = String(text == null ? '' : text);
  if (!out) return '';
  // XML 声明
  out = out.replace(/(encoding\s*=\s*)(["'])([^"']*)\2/gi, (match, head, quote) => head + quote + 'utf-8' + quote);
  // HTML meta charset / http-equiv content
  out = out.replace(/(charset\s*=\s*)(["']?)([A-Za-z0-9_.:\-]+)\2/gi, (match, head, quote) => head + quote + 'utf-8' + quote);
  // CSS @charset 必须位于文件最前面
  out = out.replace(/^(\uFEFF?@charset\s+)(["'])([^"']*)\2(\s*;)/i, (match, head, quote, value, tail) => head + quote + 'utf-8' + quote + tail);
  return out;
}

/** 该扩展名是否按文本处理（需要转码 + 改写声明）。 */
function isTextExtension(ext) {
  return TEXT_EXTENSIONS.has(String(ext || '').toLowerCase());
}

module.exports = {
  decodeSmart,
  detectDeclaredCharset,
  rewriteCharsetDecl,
  isLegacyCharset,
  isTextExtension,
  normalizeCharset,
  TEXT_EXTENSIONS
};
