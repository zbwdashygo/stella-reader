#!/usr/bin/env node
/**
 * gen-fixtures.mjs — 生成 / 校验 E2E 测试用 EPUB 样例
 *
 * 用法（在项目根或 test 目录执行均可）：
 *   node test/gen-fixtures.mjs                 # 生成中文样例（若缺失）+ 校验全部样例
 *   node test/gen-fixtures.mjs --force         # 强制重新生成中文样例
 *   node test/gen-fixtures.mjs --download-english  # 从 Project Gutenberg 下载英文真实样例（覆盖）
 *   node test/gen-fixtures.mjs --check         # 只校验，不生成
 *
 * 产物：
 *   test/fixtures/中文样例.epub   — 自建合法 EPUB3：两级 nav、中文书名/作者、PNG 封面、
 *                                  css、PNG 插图、6 章正文、关键词「听书」、章内锚点/外链
 *   test/fixtures/english.epub    — Project Gutenberg #1342《Pride and Prejudice》（真实 EPUB2/ncx）
 *                                  缺失时自动生成内置英文保底样例
 *
 * 依赖：adm-zip（项目根 node_modules）
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const CN_PATH = path.join(FIXTURES, '中文样例.epub');
const EN_PATH = path.join(FIXTURES, 'english.epub');

const GUTENBERG_URL = 'https://www.gutenberg.org/ebooks/1342.epub';

const argv = process.argv.slice(2);
const FLAG = (name) => argv.includes(name);

/* ------------------------------------------------------------------ *
 * 0. 极简 PNG 编码器（8bit RGB，无外部依赖）
 * ------------------------------------------------------------------ */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(canvas) {
  const { w, h, data } = canvas;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    data.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * 1. 简易绘图画布
 * ------------------------------------------------------------------ */
function makeCanvas(w, h) {
  return { w, h, data: Buffer.alloc(w * h * 3) };
}

function blend(canvas, x, y, [r, g, b], alpha = 1) {
  if (x < 0 || y < 0 || x >= canvas.w || y >= canvas.h) return;
  const i = (y * canvas.w + x) * 3;
  if (alpha >= 1) {
    canvas.data[i] = r;
    canvas.data[i + 1] = g;
    canvas.data[i + 2] = b;
  } else {
    canvas.data[i] = Math.round(canvas.data[i] * (1 - alpha) + r * alpha);
    canvas.data[i + 1] = Math.round(canvas.data[i + 1] * (1 - alpha) + g * alpha);
    canvas.data[i + 2] = Math.round(canvas.data[i + 2] * (1 - alpha) + b * alpha);
  }
}

function vGradient(canvas, top, bottom) {
  for (let y = 0; y < canvas.h; y++) {
    const t = y / (canvas.h - 1);
    const col = top.map((v, i) => Math.round(v + (bottom[i] - v) * t));
    for (let x = 0; x < canvas.w; x++) blend(canvas, x, y, col);
  }
}

function fillRect(canvas, x0, y0, w, h, color, alpha = 1) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) blend(canvas, x, y, color, alpha);
}

function strokeRect(canvas, x0, y0, w, h, thickness, color, alpha = 1) {
  fillRect(canvas, x0, y0, w, thickness, color, alpha);
  fillRect(canvas, x0, y0 + h - thickness, w, thickness, color, alpha);
  fillRect(canvas, x0, y0, thickness, h, color, alpha);
  fillRect(canvas, x0 + w - thickness, y0, thickness, h, color, alpha);
}

function fillCircle(canvas, cx, cy, rad, color, alpha = 1) {
  const r2 = rad * rad;
  for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++) {
    for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) blend(canvas, x, y, color, alpha);
    }
  }
}

function fillPolygon(canvas, pts, color, alpha = 1) {
  const ys = pts.map((p) => p[1]);
  const yMin = Math.max(0, Math.floor(Math.min(...ys)));
  const yMax = Math.min(canvas.h - 1, Math.ceil(Math.max(...ys)));
  for (let y = yMin; y <= yMax; y++) {
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.ceil(xs[k]); x <= Math.floor(xs[k + 1]); x++) blend(canvas, x, y, color, alpha);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 2. 封面 / 插图绘制
 * ------------------------------------------------------------------ */
function makeCoverPNG() {
  const W = 600;
  const H = 900;
  const c = makeCanvas(W, H);
  // 墨绿渐变底
  vGradient(c, [17, 40, 34], [47, 111, 94]);
  // 中心柔光
  fillCircle(c, 300, 330, 230, [201, 162, 39], 0.06);
  fillCircle(c, 300, 330, 160, [201, 162, 39], 0.06);
  // 双线金色边框
  strokeRect(c, 36, 36, W - 72, H - 72, 3, [201, 162, 39], 0.85);
  strokeRect(c, 48, 48, W - 96, H - 96, 1, [201, 162, 39], 0.5);
  // 月亮
  fillCircle(c, 300, 312, 80, [232, 204, 120], 0.95);
  fillCircle(c, 300, 312, 66, [247, 231, 184], 1);
  fillCircle(c, 276, 288, 14, [232, 204, 120], 0.55);
  fillCircle(c, 322, 332, 9, [232, 204, 120], 0.45);
  // 声波（听书意象）
  const bars = [26, 44, 66, 96, 120, 96, 66, 44, 26];
  const startX = 300 - (bars.length * 32) / 2 + 10;
  bars.forEach((bh, i) => {
    const bx = startX + i * 32;
    fillRect(c, bx, 470 - bh / 2, 10, bh, [201, 162, 39], 0.8);
  });
  // 打开的书（两页）
  fillPolygon(c, [[118, 590], [292, 570], [292, 846], [118, 822]], [240, 236, 222], 0.94);
  fillPolygon(c, [[308, 570], [482, 590], [482, 822], [308, 846]], [248, 245, 232], 0.94);
  // 书脊阴影
  fillRect(c, 292, 570, 16, 276, [26, 52, 44], 0.25);
  // 书页文字线
  for (let i = 0; i < 7; i++) {
    const y = 620 + i * 30;
    fillRect(c, 146, y, 116 - (i % 3) * 18, 5, [47, 111, 94], 0.32);
    fillRect(c, 338, y + 4, 116 - ((i + 1) % 3) * 18, 5, [47, 111, 94], 0.32);
  }
  // 底部题签
  fillRect(c, 214, 782, 172, 2, [201, 162, 39], 0.8);
  fillCircle(c, 300, 812, 5, [201, 162, 39], 0.9);
  fillRect(c, 214, 838, 172, 2, [201, 162, 39], 0.8);
  return encodePNG(c);
}

function makeIllustrationPNG() {
  const W = 900;
  const H = 500;
  const c = makeCanvas(W, H);
  vGradient(c, [243, 238, 222], [208, 226, 218]);
  // 太阳
  fillCircle(c, 650, 138, 58, [232, 204, 120], 0.95);
  fillCircle(c, 650, 138, 42, [247, 231, 184], 1);
  // 远山
  fillPolygon(c, [[0, 356], [150, 208], [300, 330], [470, 176], [650, 332], [780, 236], [900, 326], [900, 500], [0, 500]], [154, 178, 160], 0.9);
  // 中山
  fillPolygon(c, [[0, 408], [190, 268], [360, 392], [560, 246], [760, 400], [900, 320], [900, 500], [0, 500]], [88, 129, 108], 0.95);
  // 近山
  fillPolygon(c, [[0, 468], [220, 338], [430, 452], [640, 350], [900, 462], [900, 500], [0, 500]], [47, 86, 72], 1);
  // 地面
  fillRect(c, 0, 470, W, 30, [38, 72, 60], 1);
  // 飞鸟（用短斜线近似）
  const birds = [[560, 86], [600, 106], [628, 78], [676, 118]];
  birds.forEach(([bx, by]) => {
    for (let i = 0; i < 8; i++) {
      blend(c, bx + i, by - Math.round(i / 2), [60, 76, 68], 0.8);
      blend(c, bx - i, by - Math.round(i / 2), [60, 76, 68], 0.8);
    }
  });
  return encodePNG(c);
}

/* ------------------------------------------------------------------ *
 * 3. 中文样例正文内容
 * ------------------------------------------------------------------ */
const CN_TITLE = '听书测试样书';
const CN_AUTHOR = '测试作者';
const CN_PUBLISHER = '样例出版社';

const LONG_PARAS = [
  '把一段文字交给声音，需要耐心。句子要先被读慢，标点才有机会变成呼吸；呼吸稳了，段落才会像脚步一样一步一步往前走。',
  '听书时，耳朵比眼睛更早发现句法里的裂缝：一个多余的逗号、一处突然的转折、一句被翻译腔拉得过长的从句，都会在朗读里显形。',
  '她开始在每晚十点打开这本书，让声音替她把白天的杂音挡在门外。窗外偶尔有车驶过，像翻页时掠过纸面的风。',
  '朗读的节奏不是越快越好。遇到人物对话，要留一点迟疑；遇到景物描写，可以让声音慢下来，让颜色和光线在耳朵里多停一会儿。',
  '有时候，一个段落读到一半，她会停下来，把耳机摘下一只，确认房间里的安静还在。然后继续。',
  '听书最迷人的地方，是它允许你边走边读。走廊、地铁、厨房的水声都可以成为阅读的背景。',
  '但声音也会遮住文字的形状。生僻字、双关、排版上的留白，这些只有眼睛才能完整看见的东西，需要读者自己补回来。',
  '于是她养成了一个习惯：先听一遍，再翻回去看一遍。听书与阅读交替进行，像两条互相校准的线。',
  '夜深的时候，音量要调小一格。不是怕吵到别人，而是怕声音盖过文字本身的分量。',
  '朗读到章节末尾，停顿会自然变长。那停顿不是空白，是给读者留的余地。',
  '第二天的通勤路上，她重新点开同一章。前一夜听过的句子已经变了模样，像是被睡眠重新排列过。',
  '她渐渐明白，听书不是阅读的替代品，而是阅读的一种姿势：把头靠在椅背上，把注意力交给声音的节奏。',
  '当朗读遇到列表，节奏会变得整齐。第一项、第二项、第三项，声音像在台阶上一级一级往下走。',
  '当朗读遇到引文，语气要退后一步。那是别人的声音，不能和自己的声音混在一起。',
  '长文练习的意义，大概就在这里：让耳朵也学会长跑，而不是只在短句里打转。',
];

function cnChapterBody(id, paras, extra = '') {
  return paras.map((p) => `<p>${p}</p>`).join('\n') + (extra ? '\n' + extra : '');
}

function chapterXhtml({ id, title, body }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">
<head>
  <meta charset="UTF-8"/>
  <title>${title}</title>
  <link rel="stylesheet" type="text/css" href="../style.css"/>
</head>
<body>
  <section epub:type="chapter" id="${id}">
    <h1>${title}</h1>
${body}
  </section>
</body>
</html>
`;
}

const CN_CHAPTERS = [
  {
    file: 'text/ch1.xhtml',
    title: '第一章 初见听书',
    body: cnChapterBody(
      'ch1',
      [
        '在城市醒来之前，房间里只剩下钟摆般的声音。林听戴上耳机，点开一本书，让声音替她翻开第一页。',
        '听书并不是把阅读交给机器，而是换一种方式与文字同行。眼睛可以休息，耳朵却替我们记住节奏。',
        '她发现，当朗读的速度与呼吸一致时，长句不再急促，人物的对话也有了自己的腔调。',
        '这一章会反复出现「听书」二字，用来验证跨章全文搜索与结果高亮；如果你在搜索框里输入「听书」，应当能在多个章节里找到它。',
      ],
      `<p>下一章会讨论声音与文字的关系：<a href="ch2.xhtml">第二章 声音与文字</a>。</p>
      <p>也可以直接跳到本章的重点小节：<a href="ch2.xhtml#sounds">声音的形状</a>。</p>
      <p>参考外链（应由阅读器拦截并新窗口打开）：<a href="https://www.gutenberg.org/">Project Gutenberg</a>。</p>`
    ),
  },
  {
    file: 'text/ch2.xhtml',
    title: '第二章 声音与文字',
    body: cnChapterBody(
      'ch2',
      [
        '文字是静止的声音，声音是流动的文字。听书把两者接在一起，让阅读从眼睛流向耳朵。',
        '朗读时，标点变成呼吸，段落变成脚步，章节变成一段路。',
        '她喜欢在下午听散文，在夜里听小说。散文的句子短，留白多；小说的对白密，节奏快。',
        '插图里的山与太阳并不会发声，但朗读到这一段时，她总觉得窗外也亮了一些。',
      ],
      `<h2 id="sounds">声音的形状</h2>
      <p>声音有形状吗？有的。它藏在句子的长短里，也藏在标点之间的空隙里。</p>
      <figure>
        <img src="../images/illustration.png" alt="山与太阳的插图"/>
        <figcaption>插图：山与太阳（用于验证图片相对路径与 max-width 样式）</figcaption>
      </figure>
      <p>这一段之后回到正文，继续验证听书时的段落收集与高亮顺序。</p>`
    ),
  },
  {
    file: 'text/ch3.xhtml',
    title: '第三章 朗读的节奏',
    body: cnChapterBody('ch3', [
      '朗读的节奏由三件事决定：语速、停顿、重音。语速决定听众跟不跟得上，停顿决定听众有没有时间想，重音决定听众记不记得住。',
      '她试过把语速调到 0.9 倍，再把停顿交给标点。结果比机械地加速好听得多。',
      '有时候，节奏来自内容本身。写风的段落要轻，写雨的段落要密，写告别的段落要慢。',
      '在听书播放器里，这些选择最终变成了几个滑块：语速、音色、自动翻章。',
    ], `<p>长文练习的要点汇总在<a href="ch5.xhtml#list">第五章的三个练习</a>里，用来验证带锚点的书内链接。</p>`),
  },
  {
    file: 'text/ch4.xhtml',
    title: '第四章 夜读时光',
    body: cnChapterBody('ch4', [
      '夜间的阅读需要另一种光。屏幕调暗，字号放大，行距拉开，文字才不刺眼。',
      '听书在夜里更像陪伴。眼睛闭上，声音还亮着，故事继续往前走。',
      '她把夜间主题的底色想象成一张旧纸：不是纯黑，而是带着一点暖意的深灰。',
      '当朗读高亮跟随声音移动时，屏幕上的那一小块暖金色，就是夜里唯一亮着的灯。',
      '这一章用于验证夜间主题、朗读高亮与自动翻章的视觉表现。',
    ]),
  },
  {
    file: 'text/ch5.xhtml',
    title: '第五章 长文练习',
    body: cnChapterBody('ch5', LONG_PARAS, `<blockquote>
      <p>「听书不是替代阅读，而是让文字换一种方式抵达。」——测试作者</p>
    </blockquote>
    <h2 id="list">长文的三个练习</h2>
    <ol>
      <li>先完整听一遍，不暂停，记录走神的位置。</li>
      <li>回到走神的位置，用眼睛重读，比较两种感受。</li>
      <li>把最喜欢的句子抄下来，再听一遍它被读出来的样子。</li>
    </ol>
    <p>以上列表与引文也用于验证朗读时的段落收集顺序（p、h1-h6、li、blockquote，且不重复嵌套段落）。</p>`),
  },
  {
    file: 'text/ch6.xhtml',
    title: '第六章 尾声',
    body: cnChapterBody('ch6', [
      '书读到最后，声音也慢了下来。林听关掉朗读，摘下耳机，让房间恢复安静。',
      '她知道明天还会打开这本书，从上次停下的地方继续。听书与阅读，本来就可以是同一件事。',
      '（全书完）',
    ]),
  },
];

const CN_NAV = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">
<head>
  <meta charset="UTF-8"/>
  <title>目录</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol>
      <li>
        <a href="text/ch1.xhtml">第一部 · 听书入门</a>
        <ol>
          <li><a href="text/ch1.xhtml">第一章 初见听书</a></li>
          <li><a href="text/ch2.xhtml">第二章 声音与文字</a></li>
        </ol>
      </li>
      <li>
        <a href="text/ch3.xhtml">第二部 · 进阶聆听</a>
        <ol>
          <li><a href="text/ch3.xhtml">第三章 朗读的节奏</a></li>
          <li><a href="text/ch4.xhtml">第四章 夜读时光</a></li>
          <li><a href="text/ch5.xhtml">第五章 长文练习</a></li>
        </ol>
      </li>
      <li><a href="text/ch6.xhtml">第六章 尾声</a></li>
    </ol>
  </nav>
  <nav epub:type="landmarks" id="landmarks" hidden="hidden">
    <h2>书标</h2>
    <ol>
      <li><a epub:type="cover" href="nav.xhtml">封面</a></li>
      <li><a epub:type="toc" href="nav.xhtml">目录</a></li>
      <li><a epub:type="bodymatter" href="text/ch1.xhtml">正文</a></li>
    </ol>
  </nav>
</body>
</html>
`;

const CN_CSS = `/* 中文样例书样式：用于验证前端注入样式与相对路径解析 */
html, body { margin: 0; padding: 0; background: #fbf8f1; color: #2b2b2b; }
body {
  font-family: "Songti SC", "SimSun", "Noto Serif CJK SC", serif;
  font-size: 18px;
  line-height: 1.9;
  max-width: 46em;
  margin: 0 auto;
  padding: 2em 1.5em;
}
h1 { font-size: 1.7em; margin: 0 0 1.2em; line-height: 1.4; }
h2 { font-size: 1.3em; margin: 2em 0 0.8em; }
p { margin: 0 0 1.05em; text-indent: 2em; text-align: justify; }
p:first-of-type { text-indent: 0; }
blockquote { margin: 1.4em 0; padding: 0.6em 1.2em; border-left: 3px solid #c9a227; color: #5a5a5a; }
figure { margin: 1.6em 0; text-align: center; }
figure img { max-width: 100%; height: auto; border-radius: 4px; }
figcaption { font-size: 0.86em; color: #777; margin-top: 0.5em; }
a { color: #2f6f5e; }
ol, li { line-height: 1.9; }
`;

const CN_CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

function cnOpf() {
  const manifest = [
    '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '    <item id="css" href="style.css" media-type="text/css"/>',
    '    <item id="cover-image" href="images/cover.png" media-type="image/png" properties="cover-image"/>',
    '    <item id="illustration" href="images/illustration.png" media-type="image/png"/>',
    ...CN_CHAPTERS.map((ch, i) => `    <item id="ch${i + 1}" href="${ch.file}" media-type="application/xhtml+xml"/>`),
  ].join('\n');
  const spine = CN_CHAPTERS.map((_, i) => `    <itemref idref="ch${i + 1}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:2f6f5e00-0000-4000-8000-000000000003</dc:identifier>
    <dc:title>${CN_TITLE}</dc:title>
    <dc:creator>${CN_AUTHOR}</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:publisher>${CN_PUBLISHER}</dc:publisher>
    <dc:description>一本用于测试听书播放器的中文 EPUB3 样例书，包含两级目录、封面、插图、样式与六章正文。</dc:description>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>
${manifest}
  </manifest>
  <spine>
${spine}
  </spine>
</package>
`;
}

/* ------------------------------------------------------------------ *
 * 4. 英文保底样例（仅在 english.epub 缺失且下载失败时使用）
 * ------------------------------------------------------------------ */
function buildEnglishFallbackBuffer() {
  const chs = [
    {
      file: 'text/ch1.xhtml',
      title: 'Chapter One — The Small Library',
      paras: [
        'The reading room closed at dusk, and the only sound left was the soft turning of pages.',
        'Listening to a book is a different kind of reading: the eyes rest while the ears keep pace.',
        'She had come here every evening for a month, and every evening the room grew a little quieter.',
      ],
    },
    {
      file: 'text/ch2.xhtml',
      title: 'Chapter Two — Voices in the Margin',
      paras: [
        'A voice can carry a sentence the way a river carries a leaf: slowly, without hurry, and always downstream.',
        'He read aloud the way other people walked — steadily, with small pauses at the right places.',
        'The words were ordinary, but the rhythm was not.',
      ],
    },
    {
      file: 'text/ch3.xhtml',
      title: 'Chapter Three — A Long Evening',
      paras: [
        'Night settled over the town, and the lamp on the desk made a small warm circle of light.',
        'Listening, she forgot the clock, the street, and the list of things she had meant to do.',
        'When the chapter ended, she let the silence last a full minute before starting the next one.',
      ],
    },
    {
      file: 'text/ch4.xhtml',
      title: 'Chapter Four — The Last Page',
      paras: [
        'Every book ends with a page that is not really the end; it is only where the reading pauses.',
        'She closed the reader, listened to the room, and smiled.',
      ],
    },
  ];
  const zip = new AdmZip({ noSort: true }); // noSort: 保持 mimetype 为第一个条目
  const mimetypeEntry = zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'));
  mimetypeEntry.header.method = 0; // STORED
  zip.addFile('META-INF/container.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`, 'utf8'));
  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head><meta charset="UTF-8"/><title>Contents</title></head>
<body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>
${chs.map((c) => `      <li><a href="${c.file}">${c.title}</a></li>`).join('\n')}
</ol></nav></body></html>`;
  zip.addFile('OEBPS/nav.xhtml', Buffer.from(nav, 'utf8'));
  chs.forEach((ch) => {
    const html = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head><meta charset="UTF-8"/><title>${ch.title}</title>
<style>body{font-family:Georgia,serif;max-width:40em;margin:0 auto;padding:2em;line-height:1.8}p{text-indent:1.5em}</style>
</head>
<body><h1>${ch.title}</h1>
${ch.paras.map((p) => `<p>${p}</p>`).join('\n')}
</body></html>`;
    zip.addFile('OEBPS/' + ch.file, Buffer.from(html, 'utf8'));
  });
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:2f6f5e00-0000-4000-8000-000000000004</dc:identifier>
    <dc:title>English Sample — The Quiet Reader</dc:title>
    <dc:creator>QA Fixture</dc:creator>
    <dc:language>en</dc:language>
    <dc:description>Offline fallback English EPUB sample for automated tests.</dc:description>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${chs.map((c, i) => `    <item id="ch${i + 1}" href="${c.file}" media-type="application/xhtml+xml"/>`).join('\n')}
  </manifest>
  <spine>
${chs.map((_, i) => `    <itemref idref="ch${i + 1}"/>`).join('\n')}
  </spine>
</package>
`;
  zip.addFile('OEBPS/content.opf', Buffer.from(opf, 'utf8'));
  return zip.toBuffer();
}

/* ------------------------------------------------------------------ *
 * 5. 中文样例构建
 * ------------------------------------------------------------------ */
function buildChineseEpubBuffer() {
  const zip = new AdmZip({ noSort: true }); // noSort: 保持 mimetype 为第一个条目
  // mimetype 必须是第一个条目且 STORED（不压缩、无 extra field）
  const mimetypeEntry = zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'));
  mimetypeEntry.header.method = 0;
  zip.addFile('META-INF/container.xml', Buffer.from(CN_CONTAINER, 'utf8'));
  zip.addFile('OEBPS/content.opf', Buffer.from(cnOpf(), 'utf8'));
  zip.addFile('OEBPS/nav.xhtml', Buffer.from(CN_NAV, 'utf8'));
  zip.addFile('OEBPS/style.css', Buffer.from(CN_CSS, 'utf8'));
  zip.addFile('OEBPS/images/cover.png', makeCoverPNG());
  zip.addFile('OEBPS/images/illustration.png', makeIllustrationPNG());
  CN_CHAPTERS.forEach((ch, index) => {
    zip.addFile('OEBPS/' + ch.file, Buffer.from(chapterXhtml({ id: `chapter-${index + 1}`, title: ch.title, body: ch.body }), 'utf8'));
  });
  return zip.toBuffer();
}

/* ------------------------------------------------------------------ *
 * 6. 校验
 * ------------------------------------------------------------------ */
function readFirstLocalHeader(buf) {
  if (buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) return null;
  const method = buf.readUInt16LE(8);
  const flags = buf.readUInt16LE(6);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  return {
    method,
    flags,
    name: buf.slice(30, 30 + nameLen).toString('utf8'),
    extraLen,
    dataOffset: 30 + nameLen + extraLen,
  };
}

function checkEpub(file, { expectKeyword, minChapters } = {}) {
  const checks = [];
  const push = (ok, label, detail = '') => checks.push({ ok, label, detail });
  if (!fs.existsSync(file)) {
    push(false, '文件存在', file);
    return checks;
  }
  const buf = fs.readFileSync(file);
  push(buf.length > 500, '文件大小', `${buf.length} bytes`);
  push(buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50, 'ZIP 魔数 PK\\x03\\x04');

  const first = readFirstLocalHeader(buf);
  push(!!first && first.name === 'mimetype', 'mimetype 是第一个条目', first ? first.name : '无法解析本地头');
  push(!!first && first.method === 0, 'mimetype 未压缩 (STORED)', first ? `method=${first.method}` : '');
  if (first && first.method === 0) {
    const mt = buf.slice(first.dataOffset, first.dataOffset + 20).toString('utf8');
    push(mt === 'application/epub+zip', 'mimetype 内容正确', mt);
    push(first.extraLen === 0, 'mimetype 无 extra field（EPUB 规范建议）', `extraLen=${first.extraLen}`);
  }

  let zip;
  try {
    zip = new AdmZip(file);
  } catch (e) {
    push(false, '可被 adm-zip 打开', e.message);
    return checks;
  }
  const names = zip.getEntries().map((e) => e.entryName);
  push(names.includes('META-INF/container.xml'), 'META-INF/container.xml 存在');
  const container = names.includes('META-INF/container.xml') ? zip.readAsText('META-INF/container.xml') : '';
  const rootMatch = container.match(/full-path="([^"]+)"/);
  push(!!rootMatch, 'container.xml 声明 rootfile');
  if (rootMatch) {
    const opfPath = rootMatch[1];
    push(names.includes(opfPath), 'OPF 存在', opfPath);
    const opf = names.includes(opfPath) ? zip.readAsText(opfPath) : '';
    const opfVersion = (opf.match(/<package[^>]*\bversion="([^"]+)"/) || [])[1] || '?';
    const dcTitle = (opf.match(/<dc:title[^>]*>([^<]*)<\/dc:title>/) || [])[1] || '';
    push(!!dcTitle, 'OPF 有 dc:title', `${dcTitle}（EPUB 版本 ${opfVersion}）`);
    const dcCreator = (opf.match(/<dc:creator[^>]*>([^<]*)<\/dc:creator>/) || [])[1] || '';
    push(!!dcCreator, 'OPF 有 dc:creator', dcCreator);
    const manifestItems = [...opf.matchAll(/<item\b([^>]*?)\/?>/g)]
      .map((m) => ({
        href: (m[1].match(/\bhref="([^"]+)"/) || [])[1],
        type: (m[1].match(/\bmedia-type="([^"]+)"/) || [])[1],
        props: (m[1].match(/\bproperties="([^"]+)"/) || [])[1] || '',
      }))
      .filter((i) => i.href && i.type);
    push(
      manifestItems.some((i) => /^image\/(png|jpeg|jpg|webp|gif)$/.test(i.type)),
      'manifest 含图片资源（封面/插图）',
      manifestItems.filter((i) => i.type.startsWith('image/')).map((i) => i.type).join(',') || '无'
    );
    push(manifestItems.some((i) => i.type === 'text/css'), 'manifest 含 CSS');
    const spine = (opf.match(/<spine[^>]*>([\s\S]*?)<\/spine>/) || [])[1] || '';
    const spineCount = (spine.match(/<itemref\b/g) || []).length;
    push(spineCount >= (minChapters || 5), `spine 章节数 ≥ ${minChapters || 5}`, `实际 ${spineCount}`);
    const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
    let missing = 0;
    for (const item of manifestItems) {
      if (!names.includes(baseDir + item.href)) missing += 1;
    }
    push(missing === 0, 'manifest 资源全部存在于 ZIP 内', missing ? `${missing} 个缺失` : 'ok');
    const hasNav = manifestItems.some((i) => i.props.includes('nav')) || manifestItems.some((i) => /(^|\/)nav\.xhtml$/.test(i.href));
    const hasNcx = manifestItems.some((i) => i.type === 'application/x-dtbncx+xml' || /\.ncx$/i.test(i.href));
    push(hasNav || hasNcx, '目录资源（EPUB3 nav.xhtml 或 EPUB2 toc.ncx）', hasNav ? 'nav.xhtml（EPUB3）' : hasNcx ? 'toc.ncx（EPUB2）' : '缺失');
    // 目录层级：nav 里出现嵌套 ol（至少两级）
    const navItem = manifestItems.find((i) => i.props.includes('nav') || /(^|\/)nav\.xhtml$/.test(i.href));
    if (navItem) {
      const navXml = zip.readAsText(baseDir + navItem.href);
      const tocBlock = (navXml.match(/<nav[^>]*epub:type="toc"[^>]*>([\s\S]*?)<\/nav>/) || [])[1] || navXml;
      const olCount = (tocBlock.match(/<ol\b/g) || []).length;
      push(olCount >= 2, 'nav 目录至少两级（toc 内嵌套 ol）', `toc 内 <ol> 数量 ${olCount}`);
    }
    if (expectKeyword) {
      const htmlFiles = names.filter((n) => /\.(xhtml|html|htm)$/i.test(n));
      const all = htmlFiles.map((n) => zip.readAsText(n)).join('\n');
      const hits = (all.match(new RegExp(expectKeyword, 'g')) || []).length;
      push(hits > 0, `正文含关键词「${expectKeyword}」`, `出现 ${hits} 次`);
    }
    if (/<dc:description>/.test(opf)) {
      const desc = (opf.match(/<dc:description>([\s\S]*?)<\/dc:description>/) || [])[1] || '';
      push(!/<[a-z][^>]*>/i.test(desc), 'dc:description 为纯文本');
    }
  }
  // 每个 xhtml/html 至少能被 UTF-8 解码且非空
  const htmlFiles = names.filter((n) => /\.(xhtml|html|htm)$/i.test(n));
  push(htmlFiles.length >= (minChapters || 5), `HTML 文档数 ≥ ${minChapters || 5}`, `实际 ${htmlFiles.length}`);
  let bad = 0;
  for (const n of htmlFiles) {
    const txt = zip.readAsText(n);
    if (!txt || txt.length < 40 || txt.includes('\uFFFD')) bad += 1;
  }
  push(bad === 0, '所有 HTML 可解码且无替换字符', bad ? `${bad} 个异常` : 'ok');
  return checks;
}

/* ------------------------------------------------------------------ *
 * 7. 工具
 * ------------------------------------------------------------------ */
function download(url, dest, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.part';
    const file = fs.createWriteStream(tmp);
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'epub-player-qa/1.0 (fixture download)' } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.rmSync(tmp, { force: true });
          download(new URL(res.headers.location, url).toString(), dest, timeoutMs).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.rmSync(tmp, { force: true });
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            fs.renameSync(tmp, dest);
            resolve(fs.statSync(dest).size);
          });
        });
      }
    );
    req.on('error', (e) => {
      fs.rmSync(tmp, { force: true });
      reject(e);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('下载超时')));
  });
}

function printChecks(title, checks) {
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n[${failed.length ? 'FAIL' : 'PASS'}] ${title}` + (failed.length ? `（${failed.length} 项失败）` : ''));
  for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}${c.detail ? `  —  ${c.detail}` : ''}`);
  }
  return failed.length;
}

/* ------------------------------------------------------------------ *
 * 8. main
 * ------------------------------------------------------------------ */
async function main() {
  fs.mkdirSync(FIXTURES, { recursive: true });
  console.log('EPUB fixture 生成器');
  console.log(`  项目根：${ROOT}`);
  console.log(`  输出目录：${FIXTURES}`);

  let failures = 0;

  // 英文样例：优先真实 Gutenberg
  if (FLAG('--download-english')) {
    console.log(`\n↓ 下载英文真实样例：${GUTENBERG_URL}`);
    try {
      const size = await download(GUTENBERG_URL, EN_PATH);
      console.log(`  OK，${size} bytes`);
    } catch (e) {
      console.warn(`  下载失败（${e.message}），将生成内置英文保底样例`);
      fs.writeFileSync(EN_PATH, buildEnglishFallbackBuffer());
    }
  }
  if (!fs.existsSync(EN_PATH)) {
    console.log('\n☐ english.epub 缺失，生成内置英文保底样例');
    fs.writeFileSync(EN_PATH, buildEnglishFallbackBuffer());
  }

  // 中文样例
  if (!fs.existsSync(CN_PATH) || FLAG('--force')) {
    console.log(`\n✎ 生成中文样例：${path.basename(CN_PATH)}`);
    const buf = buildChineseEpubBuffer();
    fs.writeFileSync(CN_PATH, buf);
    console.log(`  OK，${buf.length} bytes，${CN_CHAPTERS.length} 章`);
  } else {
    console.log(`\n☑ 中文样例已存在：${path.basename(CN_PATH)}（--force 可重新生成）`);
  }

  if (!FLAG('--no-check')) {
    failures += printChecks(`${path.basename(CN_PATH)}（中文 EPUB3）`, checkEpub(CN_PATH, { expectKeyword: '听书', minChapters: 5 }));
    failures += printChecks(`${path.basename(EN_PATH)}（英文样例）`, checkEpub(EN_PATH, { minChapters: 4 }));
  }

  console.log('\n样例清单：');
  for (const f of [CN_PATH, EN_PATH]) {
    if (fs.existsSync(f)) console.log(`  ✓ ${f}  (${fs.statSync(f).size} bytes)`);
    else console.log(`  ✗ ${f} 缺失`);
  }
  console.log(failures ? `\n结果：FAIL（${failures} 项校验失败）` : '\n结果：PASS（样例可用）');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('生成失败：', e);
  process.exit(1);
});
