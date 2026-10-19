'use strict';
/**
 * 由 shell/icon.svg 生成 shell/icon.ico（256x256 PNG-in-ICO）。
 * 渲染用系统自带 Edge headless，无需额外依赖。
 * 用法: node shell/make-icon.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = __dirname;
const SVG = path.join(DIR, 'icon.svg');
const PNG = path.join(DIR, 'icon-256.png');
const ICO = path.join(DIR, 'icon.ico');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function findBrowser() {
  for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('未找到 Edge/Chrome，无法渲染图标');
}

function renderPng() {
  if (fs.existsSync(PNG) && fs.statSync(PNG).mtimeMs > fs.statSync(SVG).mtimeMs) {
    console.log('图标 PNG 已是最新:', PNG);
    return;
  }
  const browser = findBrowser();
  const out = path.dirname(PNG);
  fs.mkdirSync(out, { recursive: true });
  const html = path.join(out, '_icon.html');
  fs.writeFileSync(html, `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">
<img src="file:///${SVG.replace(/\\/g, '/')}" width="256" height="256" style="display:block"></body></html>`, 'utf8');
  execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--default-background-color=00000000',
    '--force-device-scale-factor=1',
    '--window-size=256,256',
    `--screenshot=${PNG}`,
    `file:///${html.replace(/\\/g, '/')}`,
  ], { stdio: 'ignore', timeout: 60000 });
  fs.rmSync(html, { force: true });
  if (!fs.existsSync(PNG)) throw new Error('图标渲染失败');
  console.log('已生成', PNG);
}

function makeIco() {
  const png = fs.readFileSync(PNG);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0);  // width 256 -> 0
  entry.writeUInt8(0, 1);  // height 256 -> 0
  entry.writeUInt8(0, 2);  // palette
  entry.writeUInt8(0, 3);  // reserved
  entry.writeUInt16LE(1, 4);   // planes
  entry.writeUInt16LE(32, 6);  // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(6 + 16, 12);
  fs.writeFileSync(ICO, Buffer.concat([header, entry, png]));
  console.log('已生成', ICO, `${png.length} bytes PNG`);
}

renderPng();
makeIco();
