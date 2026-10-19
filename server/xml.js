'use strict';

/**
 * 极简 XML / XHTML DOM 解析器（仅供 EPUB 内部 OPF / NCX / nav 解析使用）。
 *
 * 设计目标：
 *  - 容错：不因少量不规范标记（HTML 风格的 void 标签、多余空格）直接失败；
 *  - 只做我们需要的部分：元素、属性（去掉命名空间前缀）、文本、CDATA、注释；
 *  - 不追求完整 XML 规范，但保证常见 EPUB 的 OPF / NCX / nav 都能解析。
 *
 * 节点结构：
 *   { type: 'element', name: 'localname', rawName: 'dc:title',
 *     attrs: { title: '...' }, children: [...], text: '后代文本拼接' }
 * 文本节点没有单独节点，直接累加到所属元素的 text 字段（文档顺序）。
 * 读取文本请用 textOf(node)，会做实体解码与空白归一化。
 */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  sbquo: '\u201a',
  bdquo: '\u201e',
  laquo: '\u00ab',
  raquo: '\u00bb',
  middot: '\u00b7',
  bull: '\u2022',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  deg: '\u00b0',
  times: '\u00d7',
  divide: '\u00f7',
  shy: '\u00ad',
  zwj: '\u200d',
  zwnj: '\u200c',
  lrm: '\u200e',
  rlm: '\u200f',
  iquest: '\u00bf',
  iexcl: '\u00a1'
};

/** 解码 XML / HTML 实体。未知实体保持原样。 */
function decodeEntities(input) {
  if (typeof input !== 'string' || input.indexOf('&') === -1) return input || '';
  return input.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]+);/g, (match, body) => {
    try {
      if (body.charAt(0) === '#') {
        const codePoint =
          body.charAt(1) === 'x' || body.charAt(1) === 'X'
            ? parseInt(body.slice(2), 16)
            : parseInt(body.slice(1), 10);
        if (Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
          return String.fromCodePoint(codePoint);
        }
        return match;
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named !== undefined ? named : match;
    } catch {
      return match;
    }
  });
}

/** 取元素本地名（去掉命名空间前缀）并小写。 */
function localName(rawName) {
  const text = String(rawName || '').trim();
  const index = text.lastIndexOf(':');
  return (index === -1 ? text : text.slice(index + 1)).toLowerCase();
}

function parseAttrs(raw) {
  const attrs = {};
  if (!raw) return attrs;
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    const name = match[1];
    if (!name || name === '/') continue;
    let value = '';
    if (match[2] !== undefined) value = match[2];
    else if (match[3] !== undefined) value = match[3];
    else if (match[4] !== undefined) value = match[4];
    const key = localName(name);
    if (!(key in attrs)) attrs[key] = decodeEntities(value);
  }
  return attrs;
}

function createElement(rawName, attrs) {
  const name = localName(rawName);
  return {
    type: 'element',
    name,
    rawName: String(rawName || '').trim(),
    attrs: attrs || {},
    children: [],
    text: ''
  };
}

/**
 * 解析 XML 文本，返回根节点（type: 'root'）。
 * 输入非法时不会抛异常，而是尽力返回已解析的部分。
 */
function parseXml(input) {
  const source = String(input == null ? '' : input).replace(/^\uFEFF/, '');
  const root = { type: 'root', name: '#root', rawName: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const current = () => stack[stack.length - 1];
  let i = 0;
  const n = source.length;

  const appendText = (text) => {
    if (!text) return;
    current().text += text;
  };

  while (i < n) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      appendText(source.slice(i));
      break;
    }
    if (lt > i) appendText(source.slice(i, lt));
    i = lt;

    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', i)) {
      const end = source.indexOf(']]>', i + 9);
      const cdata = end === -1 ? source.slice(i + 9) : source.slice(i + 9, end);
      appendText(cdata);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (source.startsWith('<?', i)) {
      const end = source.indexOf('?>', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (source.startsWith('<!', i)) {
      // DOCTYPE（可能带内部子集 [ ... ]）
      let depth = 0;
      let j = i + 2;
      for (; j < n; j += 1) {
        const ch = source[j];
        if (ch === '[') depth += 1;
        else if (ch === ']') depth -= 1;
        else if (ch === '>' && depth <= 0) break;
      }
      i = j >= n ? n : j + 1;
      continue;
    }
    if (source[i + 1] === '/') {
      const end = source.indexOf('>', i + 2);
      if (end === -1) {
        i = n;
        break;
      }
      const name = localName(source.slice(i + 2, end));
      for (let k = stack.length - 1; k > 0; k -= 1) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      i = end + 1;
      continue;
    }

    // 开始标签：找到不受引号包裹的 '>'
    let j = i + 1;
    let quote = null;
    for (; j < n; j += 1) {
      const ch = source[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
    }
    if (j >= n) {
      i = n;
      break;
    }
    let body = source.slice(i + 1, j);
    let selfClosing = false;
    if (body.endsWith('/')) {
      selfClosing = true;
      body = body.slice(0, -1);
    }
    const nameMatch = body.match(/^\s*([^\s/>]+)/);
    if (!nameMatch) {
      i = j + 1;
      continue;
    }
    const rawName = nameMatch[1];
    const attrs = parseAttrs(body.slice(nameMatch[0].length));
    const element = createElement(rawName, attrs);
    current().children.push(element);

    const skipContent = element.name === 'script' || element.name === 'style';
    if (selfClosing || skipContent) {
      if (skipContent) {
        // 跳过 script/style 内容直到对应结束标签，避免其中的 '<' 破坏解析
        const closeRe = new RegExp('</\\s*' + element.name + '\\s*>', 'i');
        const rest = source.slice(j + 1);
        const match = closeRe.exec(rest);
        if (match) {
          i = j + 1 + match.index + match[0].length;
        } else {
          i = n;
        }
      } else {
        i = j + 1;
      }
      continue;
    }
    stack.push(element);
    i = j + 1;
  }

  return root;
}

/** 取元素的后代文本（按文档顺序拼接），默认解码实体、压缩空白。 */
function textOf(node, options) {
  if (!node) return '';
  const opts = options || {};
  let text = typeof node.text === 'string' ? node.text : '';
  if (opts.decode !== false) text = decodeEntities(text);
  if (opts.collapse !== false) text = text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ');
  return opts.trim === false ? text : text.trim();
}

/** 直接子元素。 */
function childrenOf(node) {
  if (!node || !Array.isArray(node.children)) return [];
  return node.children.filter((child) => child.type === 'element');
}

/** 深度优先查找第一个满足条件的元素。 */
function findFirst(node, predicate) {
  if (!node || !Array.isArray(node.children)) return null;
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    if (predicate(child)) return child;
    const found = findFirst(child, predicate);
    if (found) return found;
  }
  return null;
}

/** 深度优先查找所有满足条件的元素。 */
function findAll(node, predicate) {
  const out = [];
  if (!node || !Array.isArray(node.children)) return out;
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    if (predicate(child)) out.push(child);
    out.push(...findAll(child, predicate));
  }
  return out;
}

/** 按本地标签名查找第一个元素。 */
function findByTag(node, tag) {
  const name = String(tag).toLowerCase();
  return findFirst(node, (element) => element.name === name);
}

/**
 * 把 HTML/XHTML 片段转成纯文本（用于简介、全文搜索）。
 * 去除 script/style/head/注释，块级标签转空格，解码实体，压缩空白。
 */
function htmlToText(html) {
  let text = String(html == null ? '' : html);
  if (!text) return '';
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ');
  text = text.replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ');
  text = text.replace(/<head\b[\s\S]*?<\/head\s*>/gi, ' ');
  text = text.replace(/<br\s*\/?>/gi, ' ');
  text = text.replace(
    /<\/(?:p|div|li|ul|ol|h[1-6]|tr|td|th|blockquote|section|article|header|footer|pre|figure|figcaption|table|dd|dt)\s*>/gi,
    ' '
  );
  text = text.replace(/<[^>]*>/g, ' ');
  text = decodeEntities(text);
  text = text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ');
  return text.trim();
}

/** 极简 HTML 转义（仅用于内部生成文本，不用于 snippet 契约）。 */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  parseXml,
  textOf,
  childrenOf,
  findFirst,
  findAll,
  findByTag,
  decodeEntities,
  htmlToText,
  escapeHtml,
  localName
};
