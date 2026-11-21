'use strict';
// Oppo research export: a self-contained report (.html, opens in any browser, offline),
// a one-card overview image (.png, also copied to the clipboard for pasting into Discord)
// and the member dossiers (.csv). The page content is built by the research screen; this
// adds the app's styles, saves the files and renders the image.

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, clipboard, dialog, shell } = require('electron');

const UI = path.join(__dirname, '..', 'ui');
const REPORT_CSS = `
  html, body.report { height: auto; overflow: auto; user-select: text; }
  body.report { margin: 0; background: var(--bg-2); }
  .rp-main { max-width: 1300px; margin: 0 auto; padding: 22px 24px 48px; }
  .rp-head h1 { font-size: 22px; margin: 0 0 4px; color: var(--text); }
  .rp-overview { margin: 16px 0 26px; overflow-x: auto; }
  a { color: var(--blue); }
  @media print { body.report { background: #fff; } }
`;
const IMAGE_CSS = `
  html, body { margin: 0; height: auto; overflow: hidden; background: var(--bg-2); }
  body { padding: 20px; width: 1200px; box-sizing: border-box; }
`;

function styles() {
  return ['themes.css', 'styles.css'].map(f => fs.readFileSync(path.join(UI, f), 'utf8')).join('\n');
}

const safeName = s => String(s || 'faction').replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 60) || 'faction';
// Torn links: real links in the exported page (the app uses its own link handling).
const realLinks = html => html.replace(/data-open="/g, 'target="_blank" rel="noopener" href="');

function page(title, body, extraCss, bodyClass = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/</g, '&lt;')}</title><style>${styles()}\n${extraCss}</style></head><body class="${bodyClass}">${body}</body></html>`;
}

// The overview card as an image, drawn in a hidden window.
async function renderImage(cardHtml) {
  const win = new BrowserWindow({ show: false, width: 1200, height: 900, useContentSize: true, backgroundColor: '#222222', webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page('Overview', cardHtml, IMAGE_CSS))}`);
    const h = await win.webContents.executeJavaScript('Math.ceil(document.body.scrollHeight)');
    win.setContentSize(1200, Math.max(200, Math.min(4000, h)));
    await new Promise(r => setTimeout(r, 350));
    return await win.webContents.capturePage();
  } finally {
    win.destroy();
  }
}

async function exportResearch(p, parent) {
  const img = await renderImage(p.overview);
  // Electron 45's clipboard takes ClipboardItems (writeImage is gone).
  const ClipItem = require('electron').ClipboardItem || globalThis.ClipboardItem;
  await clipboard.write([new ClipItem({ 'image/png': new Blob([img.toPNG()], { type: 'image/png' }) })]);
  if (p.mode !== 'all') return { copied: true };
  const date = new Date().toISOString().slice(0, 10);
  const r = await dialog.showSaveDialog(parent, {
    title: 'Export Oppo Research report',
    defaultPath: path.join(app.getPath('documents'), `Oppo Research - ${safeName(p.name)} - ${date}.html`),
    filters: [{ name: 'Web page (opens in any browser)', extensions: ['html'] }],
  });
  if (r.canceled || !r.filePath) return { cancelled: true, copied: true };
  const htmlPath = r.filePath.endsWith('.html') ? r.filePath : `${r.filePath}.html`;
  const base = htmlPath.replace(/\.html$/i, '');
  const data = JSON.stringify(p.data || {}).replace(/</g, '\\u003c');
  const body = `<main class="rp-main">${realLinks(p.report)}</main>
<script type="application/json" id="research-data">${data}</script>`;
  fs.writeFileSync(htmlPath, page(`Oppo Research: ${p.name}`, body, REPORT_CSS, 'report'));
  fs.writeFileSync(`${base}.csv`, `﻿${p.csv}`); // BOM so Excel reads names correctly
  fs.writeFileSync(`${base} - overview.png`, img.toPNG());
  shell.showItemInFolder(htmlPath);
  return { copied: true, html: htmlPath, csv: `${base}.csv`, png: `${base} - overview.png` };
}

// War intelligence report: a PDF (print layout), an interactive .html with sortable and
// filterable tables (same data, opens offline in any browser) and the roster as .csv.
// Both documents are complete pages built by the research screen (ui/intel.js).
async function exportIntel(p, parent) {
  const date = new Date().toISOString().slice(0, 10);
  const r = await dialog.showSaveDialog(parent, {
    title: 'Export war intelligence report',
    defaultPath: path.join(app.getPath('documents'), `War Intelligence - ${safeName(p.name)} - ${date}.pdf`),
    filters: [{ name: 'PDF report (an interactive .html and a .csv are saved next to it)', extensions: ['pdf'] }],
  });
  if (r.canceled || !r.filePath) return { cancelled: true };
  const pdfPath = /\.pdf$/i.test(r.filePath) ? r.filePath : `${r.filePath}.pdf`;
  const base = pdfPath.replace(/\.pdf$/i, '');
  fs.writeFileSync(`${base}.html`, p.html);
  if (p.csv) fs.writeFileSync(`${base}.csv`, `﻿${p.csv}`);
  // Render from a temporary file: a long report doesn't fit in a data: URL.
  const tmp = path.join(app.getPath('temp'), `mentat-intel-${process.pid}-${Date.now()}.html`);
  fs.writeFileSync(tmp, p.pdf);
  const win = new BrowserWindow({ show: false, width: 1400, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } });
  try {
    await win.loadFile(tmp);
    await new Promise(res => setTimeout(res, 300));
    const pdf = await win.webContents.printToPDF({ landscape: true, printBackground: true, pageSize: 'A4', margins: { top: 0.35, bottom: 0.35, left: 0.35, right: 0.35 } });
    fs.writeFileSync(pdfPath, pdf);
  } finally {
    win.destroy();
    fs.unlink(tmp, () => {});
  }
  shell.showItemInFolder(pdfPath);
  return { pdf: pdfPath, html: `${base}.html`, csv: p.csv ? `${base}.csv` : '' };
}

module.exports = { exportResearch, exportIntel, renderImage };
