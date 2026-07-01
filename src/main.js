import './style.css';

const APP_VERSION = '0.2.2-20260701';
const DB_NAME = 'lunashelf-db';
const DB_VERSION = 1;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = {
  books: [],
  fonts: [],
  currentBook: null,
  theme: localStorage.getItem('theme') || 'light',
  fontFamily: localStorage.getItem('fontFamily') || 'serif',
  fontSize: Number(localStorage.getItem('fontSize') || 24),
  lineHeight: Number(localStorage.getItem('lineHeight') || 2),
  view: 'library',
  toolbarOn: false,
  panel: null,
  pages: [],
  currentPage: 0,
  lastTapAt: 0,
  sleepUntil: Number(localStorage.getItem('sleepUntil') || 0),
  sleepTimer: null,
};

class DB {
  static open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('fonts')) db.createObjectStore('fonts', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  static async tx(store, mode, fn) {
    const db = await DB.open();
    return new Promise((resolve, reject) => {
      const tr = db.transaction(store, mode);
      const st = tr.objectStore(store);
      const result = fn(st);
      tr.oncomplete = () => resolve(result?.result ?? result);
      tr.onerror = () => reject(tr.error);
    });
  }
  static all(store) { return DB.tx(store, 'readonly', st => st.getAll()); }
  static put(store, value) { return DB.tx(store, 'readwrite', st => st.put(value)); }
  static delete(store, key) { return DB.tx(store, 'readwrite', st => st.delete(key)); }
  static get(store, key) { return DB.tx(store, 'readonly', st => st.get(key)); }
}

class UpdateManager {
  static async disableServiceWorkerCache() {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(reg => reg.unregister()));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(key => caches.delete(key)));
    }
  }
  static async forceNetworkReload() {
    await UpdateManager.disableServiceWorkerCache().catch(err => console.warn('cache cleanup skipped', err));
    const url = new URL(location.href);
    url.searchParams.set('v', Date.now().toString());
    url.searchParams.set('network', 'latest');
    location.replace(url.toString());
  }
}

class FontManager {
  static async loadStoredFonts() {
    const fonts = await DB.all('fonts');
    for (const font of fonts) await FontManager.activate(font);
    return fonts;
  }
  static async import(file) {
    const data = await file.arrayBuffer();
    const clean = file.name.replace(/\.(ttf|otf|woff2?|)$/i, '') || 'CustomFont';
    const font = { id: uid(), name: clean, fileName: file.name, type: file.type || 'font/ttf', data, createdAt: Date.now() };
    await DB.put('fonts', font);
    await FontManager.activate(font);
    state.fontFamily = `custom-${font.id}`;
    localStorage.setItem('fontFamily', state.fontFamily);
    state.fonts = await DB.all('fonts');
    return font;
  }
  static async activate(font) {
    const family = `custom-${font.id}`;
    const face = new FontFace(family, font.data);
    await face.load();
    document.fonts.add(face);
  }
}

class TxtParser {
  static async parse(file) {
    const buf = await file.arrayBuffer();
    for (const enc of ['utf-8', 'big5', 'gbk']) {
      try {
        const text = new TextDecoder(enc, { fatal: enc === 'utf-8' }).decode(buf);
        if (text && !/\uFFFD{3,}/.test(text)) return TxtParser.normalize(text);
      } catch (_) { /* next encoding */ }
    }
    return TxtParser.normalize(new TextDecoder('utf-8').decode(buf));
  }
  static normalize(text) { return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim(); }
  static paragraphs(text) {
    const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
    return lines.length ? lines : [text.trim()].filter(Boolean);
  }
  static enrichBook(book) {
    if (!book.paragraphs?.length) book.paragraphs = TxtParser.paragraphs(book.content || '');
    book.content = book.content || book.paragraphs.join('\n');
    book.chapters = TxtParser.chapters(book.paragraphs);
    return book;
  }
  static chapters(paragraphs) {
    const re = /^\s*(第[一二三四五六七八九十百千萬万零〇0-9]+[章回節节卷部].{0,42}|Chapter\s+\d+.{0,42})\s*$/i;
    const found = paragraphs.map((text, idx) => ({ text, idx })).filter(p => re.test(p.text)).map(p => ({ title: p.text, idx: p.idx }));
    return found.length ? found : [{ title: '全文', idx: 0 }];
  }
}

class AudioSessionManager {
  constructor() { this.audio = null; this.objectUrl = null; }
  makeSilentWavUrl() {
    const sampleRate = 8000, seconds = 0.25, samples = sampleRate * seconds;
    const buffer = new ArrayBuffer(44 + samples * 2), view = new DataView(buffer);
    const write = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
    write(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); write(8, 'WAVE');
    write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    write(36, 'data'); view.setUint32(40, samples * 2, true);
    return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
  }
  async start(book) {
    if (!this.audio) {
      this.objectUrl = this.makeSilentWavUrl();
      this.audio = new Audio(this.objectUrl);
      this.audio.loop = true;
      this.audio.playsInline = true;
      this.audio.preload = 'auto';
      this.audio.volume = 1;
      this.audio.setAttribute('aria-hidden', 'true');
      document.body.appendChild(this.audio);
    }
    try { await this.audio.play(); } catch (err) { console.warn('Audio session start blocked', err); }
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: book?.title || '月閣', artist: 'LunaShelf', album: 'TXT Reader' });
      navigator.mediaSession.playbackState = 'playing';
      navigator.mediaSession.setActionHandler('play', () => tts.play());
      navigator.mediaSession.setActionHandler('pause', () => tts.pause());
      navigator.mediaSession.setActionHandler('stop', () => tts.stop());
      navigator.mediaSession.setActionHandler('seekbackward', () => turnPage(-1));
      navigator.mediaSession.setActionHandler('seekforward', () => turnPage(1));
    }
  }
  stop() { if (this.audio) this.audio.pause(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; }
}

class SpeechQueue {
  constructor() {
    this.state = 'idle';
    this.maxChars = 260;
    this.nextPara = 0;
    this.segments = [];
    this.segmentIndex = 0;
    this.currentUtterance = null;
    this.audioSession = new AudioSessionManager();
    this.startWatchdog = null;
  }
  isSupported() { return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window; }
  pickVoice() {
    const voices = speechSynthesis.getVoices();
    return voices.find(v => /zh-TW|zh_Hant|cmn-Hant|Taiwan/i.test(`${v.lang} ${v.name}`))
      || voices.find(v => /zh|cmn|han/i.test(`${v.lang} ${v.name}`));
  }
  splitText(text) {
    const src = text.trim();
    if (src.length <= this.maxChars) return [src];
    const out = [];
    let rest = src;
    while (rest.length > this.maxChars) {
      const win = rest.slice(0, this.maxChars);
      const cut = Math.max(win.lastIndexOf('。'), win.lastIndexOf('！'), win.lastIndexOf('？'), win.lastIndexOf('…'));
      const at = cut > 80 ? cut + 1 : this.maxChars;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) out.push(rest);
    return out;
  }
  makeUtterance(text, paraIdx) {
    const u = new SpeechSynthesisUtterance(text);
    const zh = this.pickVoice();
    if (zh) u.voice = zh;
    u.lang = zh?.lang || 'zh-TW';
    u.rate = Number(localStorage.getItem('speechRate') || 1);
    u.pitch = 1;
    u.volume = 1;
    u.onstart = () => highlightPara(paraIdx);
    u.onend = () => { this.currentUtterance = null; this.nextPara = Math.max(this.nextPara, paraIdx + 1); saveProgressFromPage(); this.speakNext(); };
    u.onerror = ev => { console.warn('TTS error', ev.error || ev); this.currentUtterance = null; this.nextPara = Math.max(this.nextPara, paraIdx + 1); this.speakNext(); };
    return u;
  }
  buildSegments(startPara) {
    const book = state.currentBook;
    const out = [];
    for (let i = startPara; book && i < book.paragraphs.length; i++) {
      for (const text of this.splitText(book.paragraphs[i] || '')) if (text) out.push({ text, paraIdx: i });
    }
    return out;
  }
  play() {
    if (!state.currentBook) return toast('請先開啟一本 TXT');
    if (!this.isSupported()) return toast('這個瀏覽器不支援朗讀，請用 Safari/Edge/Chrome 測試');
    if (this.state === 'playing') return;
    this.state = 'playing';
    const page = state.pages[state.currentPage];
    this.nextPara = page?.startPara ?? state.currentBook.progressPara ?? 0;
    this.segments = this.buildSegments(this.nextPara);
    this.segmentIndex = 0;
    speechSynthesis.cancel();
    this.currentUtterance = null;
    this.speakNext();
    this.audioSession.start(state.currentBook).catch(err => console.warn('Audio session start blocked', err));
    renderTtsState();
    clearTimeout(this.startWatchdog);
    this.startWatchdog = setTimeout(() => {
      if (this.state === 'playing' && !speechSynthesis.speaking && !speechSynthesis.pending) {
        this.state = 'idle';
        renderTtsState();
        toast('朗讀未啟動，請再點一次播放；iPhone 可能需要使用者手勢');
      }
    }, 1400);
  }
  speakNext() {
    const book = state.currentBook;
    if (this.state !== 'playing' || !book) return;
    const seg = this.segments[this.segmentIndex++];
    if (!seg) return this.stop();
    this.nextPara = seg.paraIdx;
    this.currentUtterance = this.makeUtterance(seg.text, seg.paraIdx);
    speechSynthesis.speak(this.currentUtterance);
  }
  pause() { this.state = 'paused'; this.audioSession.stop(); speechSynthesis.cancel(); this.currentUtterance = null; this.segments = []; clearTimeout(this.startWatchdog); renderTtsState(); saveProgressFromPage(); }
  stop() { this.state = 'idle'; this.audioSession.stop(); speechSynthesis.cancel(); this.currentUtterance = null; this.segments = []; clearTimeout(this.startWatchdog); renderTtsState(); saveProgressFromPage(); }
}

const tts = new SpeechQueue();

function toast(msg) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = msg;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 2300);
}
function setTheme(theme) {
  state.theme = theme;
  localStorage.setItem('theme', theme);
  document.documentElement.dataset.theme = theme;
}
function getFontCss() {
  if (state.fontFamily === 'system') return 'var(--font-system)';
  if (state.fontFamily === 'serif') return 'var(--font-serif)';
  return `'${state.fontFamily}'`;
}
function bookProgress(book) {
  const total = book.paragraphs?.length || 1;
  return Math.round(((book.progressPara || 0) / Math.max(1, total - 1)) * 100);
}
function bookCoverColor(title) {
  const colors = ['#123c33', '#321047', '#503516', '#17344f', '#4a1d24'];
  let n = 0; [...title].forEach(c => { n += c.charCodeAt(0); });
  return colors[n % colors.length];
}

async function importBook(file) {
  if (!file.name.toLowerCase().endsWith('.txt')) return toast('目前先支援 TXT');
  const content = await TxtParser.parse(file);
  const paragraphs = TxtParser.paragraphs(content);
  const book = TxtParser.enrichBook({ id: uid(), title: file.name.replace(/\.txt$/i, ''), fileName: file.name, content, paragraphs, progressPara: 0, createdAt: Date.now(), updatedAt: Date.now() });
  await DB.put('books', book);
  state.books = (await DB.all('books')).map(TxtParser.enrichBook);
  render();
  toast(`已匯入：${book.title}`);
}
async function saveBook(book) { book.updatedAt = Date.now(); await DB.put('books', book); }
function saveProgressFromPage() {
  if (!state.currentBook || !state.pages[state.currentPage]) return;
  state.currentBook.progressPara = state.pages[state.currentPage].startPara;
  saveBook(state.currentBook);
}

function getChapterIndex(paraIdx) {
  const chapters = state.currentBook?.chapters || [];
  let ci = 0;
  for (let i = chapters.length - 1; i >= 0; i--) if (chapters[i].idx <= paraIdx) { ci = i; break; }
  return ci;
}

function paginate(goToPara = 0) {
  const book = state.currentBook;
  if (!book) return;
  const probe = document.createElement('div');
  probe.className = 'page-probe';
  const topPad = 66;
  const bottomPad = 74;
  probe.style.width = `${Math.max(240, window.innerWidth - 52)}px`;
  probe.style.height = `${Math.max(260, (window.visualViewport?.height || window.innerHeight) - topPad - bottomPad - 22)}px`;
  probe.style.fontSize = `${state.fontSize}px`;
  probe.style.lineHeight = String(state.lineHeight);
  probe.style.fontFamily = getFontCss();
  document.body.appendChild(probe);
  const pages = [];
  let cursor = 0;
  let targetPage = 0;
  const chapterStarts = new Set((book.chapters || []).map(ch => ch.idx));
  while (cursor < book.paragraphs.length) {
    probe.innerHTML = '';
    const startPara = cursor;
    let endPara = cursor;
    while (endPara < book.paragraphs.length) {
      if (endPara > startPara && chapterStarts.has(endPara)) break;
      const p = document.createElement('p');
      p.className = 'para';
      p.textContent = book.paragraphs[endPara];
      probe.appendChild(p);
      if (probe.scrollHeight > probe.clientHeight) {
        probe.removeChild(p);
        if (endPara === startPara) endPara += 1;
        break;
      }
      endPara += 1;
    }
    const page = { startPara, endPara: Math.max(startPara, endPara - 1), chapterIdx: getChapterIndex(startPara) };
    if (startPara <= goToPara && goToPara <= page.endPara) targetPage = pages.length;
    pages.push(page);
    cursor = Math.max(endPara, startPara + 1);
  }
  probe.remove();
  state.pages = pages.length ? pages : [{ startPara: 0, endPara: 0, chapterIdx: 0 }];
  state.currentPage = Math.min(targetPage, state.pages.length - 1);
}
function renderPage() {
  const body = $('.rp-body');
  const foot = $('.rp-num');
  const pct = $('.rf-pct');
  const bar = $('.rf-prog-f');
  const title = $('.rtitle');
  if (!body || !state.currentBook) return;
  const page = state.pages[state.currentPage] || state.pages[0];
  const chapter = state.currentBook.chapters?.[page.chapterIdx];
  title && (title.textContent = state.currentBook.title);
  body.style.fontSize = `${state.fontSize}px`;
  body.style.lineHeight = String(state.lineHeight);
  body.style.fontFamily = getFontCss();
  body.innerHTML = '';
  for (let i = page.startPara; i <= page.endPara && i < state.currentBook.paragraphs.length; i++) {
    const p = document.createElement('p');
    p.className = 'para';
    p.dataset.paraIdx = i;
    p.textContent = state.currentBook.paragraphs[i];
    body.appendChild(p);
  }
  if (chapter && page.startPara === chapter.idx) body.insertAdjacentHTML('afterbegin', `<h2 class="chapter-title">${esc(chapter.title)}</h2>`);
  const total = state.pages.length || 1;
  const percent = total > 1 ? Math.round((state.currentPage / (total - 1)) * 100) : 0;
  foot && (foot.textContent = `${state.currentPage + 1} / ${total}`);
  pct && (pct.textContent = `${percent}%`);
  bar && (bar.style.width = `${percent}%`);
  saveProgressFromPage();
}
function turnPage(dir) {
  if (!state.currentBook) return;
  const next = Math.max(0, Math.min(state.pages.length - 1, state.currentPage + dir));
  if (next === state.currentPage) return toast(dir > 0 ? '已是最後一頁' : '已是第一頁');
  tts.stop();
  state.currentPage = next;
  renderPage();
}
function repaginateKeepPosition() {
  const para = state.pages[state.currentPage]?.startPara || state.currentBook?.progressPara || 0;
  paginate(para);
  renderPage();
}
function toggleToolbar(force) {
  state.toolbarOn = typeof force === 'boolean' ? force : !state.toolbarOn;
  $('.reader-head')?.classList.toggle('show', state.toolbarOn);
  $('.reader-controls')?.classList.toggle('show', state.toolbarOn);
}
function handleReaderTap(e) {
  if (!state.currentBook) return;
  if (e.cancelable) e.preventDefault();
  if (e.target.closest('.reader-head, .reader-controls, .pback, button, input, select, label')) return;
  const now = Date.now();
  if (now - state.lastTapAt < 260) return;
  state.lastTapAt = now;
  const x = e.clientX ?? e.changedTouches?.[0]?.clientX;
  if (!Number.isFinite(x)) return;
  const ratio = x / window.innerWidth;
  if (ratio < 0.28) turnPage(-1);
  else if (ratio > 0.72) turnPage(1);
  else toggleToolbar();
}
function openPanel(panel) { state.panel = panel; renderPanel(); }
function closePanel() { state.panel = null; renderPanel(); }
function jumpChapter(i) {
  const ch = state.currentBook?.chapters?.[i];
  if (!ch) return;
  paginate(ch.idx);
  closePanel();
  renderPage();
}
function highlightPara(idx) {
  const pg = state.pages.findIndex(p => idx >= p.startPara && idx <= p.endPara);
  if (pg >= 0 && pg !== state.currentPage) { state.currentPage = pg; renderPage(); }
  $$('.para.tts-hi').forEach(el => el.classList.remove('tts-hi'));
  $(`.para[data-para-idx="${idx}"]`)?.classList.add('tts-hi');
}
function renderTtsState() {
  const btn = $('#rfPlay');
  if (btn) btn.textContent = tts.state === 'playing' ? '⏸' : '▶';
}
function sleepMinutesLeft() {
  return Math.max(0, Math.ceil((state.sleepUntil - Date.now()) / 60000));
}
function setSleepTimer(minutes) {
  clearTimeout(state.sleepTimer);
  if (!minutes) {
    state.sleepUntil = 0;
    localStorage.removeItem('sleepUntil');
    toast('已關閉定時');
  } else {
    state.sleepUntil = Date.now() + minutes * 60000;
    localStorage.setItem('sleepUntil', String(state.sleepUntil));
    state.sleepTimer = setTimeout(() => { tts.stop(); state.sleepUntil = 0; localStorage.removeItem('sleepUntil'); toast('定時結束，已停止朗讀'); renderPanel(); }, minutes * 60000);
    toast(`已設定 ${minutes} 分鐘後停止`);
  }
  renderPanel();
}
function restoreSleepTimer() {
  const left = state.sleepUntil - Date.now();
  if (left > 0) state.sleepTimer = setTimeout(() => { tts.stop(); state.sleepUntil = 0; localStorage.removeItem('sleepUntil'); toast('定時結束，已停止朗讀'); renderPanel(); }, left);
  else { state.sleepUntil = 0; localStorage.removeItem('sleepUntil'); }
}

function libraryTemplate() {
  return `
    <header class="lhd"><div class="lhd-logo">月閣 <small>LunaShelf v${APP_VERSION}</small></div><button class="ibt" id="refreshBtn" aria-label="強制更新">↻</button><button class="ibt" id="themeBtn" aria-label="切換夜間">${state.theme === 'dark' ? '☀' : '🌙'}</button><button class="ibt" id="topImportBtn" aria-label="匯入 TXT">＋</button></header>
    <main class="lbody">
      <div class="lbar"><span class="lbar-t">書庫</span><div class="lbar-l"></div><span class="lbar-c">${state.books.length} 本</span></div>
      <section class="blist">${state.books.map(bookRow).join('') || '<div class="bempty"><div class="bempty-ico">書</div><div class="bempty-txt">書庫空空如也<br>上傳 TXT 格式小說開始閱讀</div><label class="bempty-btn">＋ 上傳第一本書<input id="emptyImport" type="file" accept=".txt,text/plain" hidden></label></div>'}</section>
    </main>
    <button class="fab" id="fab" aria-label="上傳書籍">＋</button><input id="bookInput" type="file" accept=".txt,text/plain" hidden>`;
}
function bookRow(book) {
  const pct = bookProgress(book);
  return `<article class="brow" data-open="${book.id}"><div class="brow-cov" style="background:${bookCoverColor(book.title)}"><span>${esc(book.title)}</span></div><div class="brow-info"><div class="brow-title">${esc(book.title)}</div><div class="brow-meta"><span>${book.chapters?.length || 1} 章</span><span>${book.paragraphs?.length || 0} 段</span></div><div class="brow-prog-wrap"><div class="brow-prog"><div class="brow-prog-f" style="width:${pct}%"></div></div><span class="brow-pct">${pct}%</span></div></div><button class="brow-del" data-delete="${book.id}" aria-label="刪除">×</button></article>`;
}
function readerTemplate() {
  const book = state.currentBook;
  return `
    <section class="reader-view">
      <header class="reader-head ${state.toolbarOn ? 'show' : ''}"><button class="rbk" id="backBtn">◀ 書庫</button><div class="rtitle">${esc(book.title)}</div><div class="rtool"><button class="ribt" id="tocBtn">☰</button><button class="ribt" id="setBtn">⚙</button></div></header>
      <main class="rbook" id="rbook"><div class="tap-zone zone-left" id="zoneLeft"></div><div class="tap-zone zone-mid" id="zoneMid"></div><div class="tap-zone zone-right" id="zoneRight"></div><article class="rpage"><div class="rp-body"></div><footer class="rp-foot"><span class="rp-num">…</span></footer></article></main>
      <footer class="reader-controls ${state.toolbarOn ? 'show' : ''}"><button class="rfbt" id="rfPlay">▶</button><button class="rfbt" id="rfStop">⏹</button><div class="rf-div"></div><button class="rffont" id="fontMinus">A−</button><button class="rffont" id="fontPlus">A+</button><div class="rf-div"></div><button class="rftog" id="themeBtn">${state.theme === 'dark' ? '☀' : '🌙'}</button><div class="rf-prog-wrap"><div class="rf-prog" id="rfProg"><div class="rf-prog-f"></div></div><span class="rf-pct">0%</span></div></footer>
      <div id="panelRoot"></div>
    </section>`;
}
function panelTemplate() {
  if (!state.panel) return '';
  if (state.panel === 'toc') {
    const chapters = state.currentBook?.chapters || [];
    return `<div class="pback on"><div class="pov" id="panelClose"></div><div class="pbox"><div class="phd"><span class="phd-t">📖 章節目錄</span><button class="pcls" id="panelX">×</button></div><div class="pbody">${chapters.map((ch, i) => `<div class="toc-item" data-chapter="${i}"><span class="toc-n">${i + 1}</span><span class="toc-t">${esc(ch.title)}</span><span class="toc-arr">›</span></div>`).join('') || '<div class="toc-empty">未偵測到章節標題</div>'}</div></div></div>`;
  }
  const importedFonts = state.fonts.map(f => `<div class="font-row"><button class="font-opt ${state.fontFamily === `custom-${f.id}` ? 'on' : ''}" data-font="custom-${f.id}">${esc(f.name)}</button><button class="font-del" data-font-delete="${f.id}" aria-label="刪除字體">×</button></div>`).join('');
  const sleepLeft = sleepMinutesLeft();
  const sleepBtns = [0, 5, 10, 15, 30].map(min => `<button class="slp-bt ${(min === 0 && !sleepLeft) || (min > 0 && sleepLeft === min) ? 'on' : ''}" data-sleep="${min}">${min ? `${min}分` : '關閉'}</button>`).join('');
  return `<div class="pback on"><div class="pov" id="panelClose"></div><div class="pbox"><div class="phd"><span class="phd-t">⚙ 閱讀設定</span><button class="pcls" id="panelX">×</button></div><div class="pbody"><div class="sg"><div class="sg-lbl">字體</div><div class="font-opts"><button class="font-opt ${state.fontFamily === 'serif' ? 'on' : ''}" data-font="serif">宋體</button><button class="font-opt ${state.fontFamily === 'system' ? 'on' : ''}" data-font="system">黑體</button></div><div class="font-list">${importedFonts || '<div class="sg-hint">尚未匯入自訂字體</div>'}</div><label class="font-import-btn">＋ 匯入字體<input id="panelFontInput" type="file" accept=".ttf,.otf,.woff,.woff2,font/*" hidden></label></div><div class="sg"><div class="sg-lbl">聽書語速</div><div class="spd-wrap"><input type="range" class="spd-slider" id="speechRate" min="0.5" max="2.5" step="0.1" value="${localStorage.getItem('speechRate') || 1}"><span class="spd-val">${Number(localStorage.getItem('speechRate') || 1).toFixed(1)}×</span></div></div><div class="sg"><div class="sg-lbl">定時關閉 ${sleepLeft ? `· 剩 ${sleepLeft} 分` : ''}</div><div class="slp-wrap">${sleepBtns}</div></div></div></div></div>`;
}
function renderPanel() {
  const root = $('#panelRoot');
  if (!root) return;
  root.innerHTML = panelTemplate();
  bindPanelEvents();
}

async function openBook(id) {
  state.currentBook = TxtParser.enrichBook(await DB.get('books', id));
  state.view = 'reader';
  state.toolbarOn = false;
  paginate(state.currentBook.progressPara || 0);
  await render();
}
function bindPanelEvents() {
  $('#panelClose')?.addEventListener('click', closePanel);
  $('#panelX')?.addEventListener('click', closePanel);
  $$('[data-chapter]').forEach(el => el.addEventListener('click', () => jumpChapter(Number(el.dataset.chapter))));
  $$('[data-font]').forEach(btn => btn.addEventListener('click', () => { state.fontFamily = btn.dataset.font; localStorage.setItem('fontFamily', state.fontFamily); closePanel(); repaginateKeepPosition(); }));
  $$('[data-font-delete]').forEach(btn => btn.addEventListener('click', async e => { e.stopPropagation(); await DB.delete('fonts', btn.dataset.fontDelete); if (state.fontFamily === `custom-${btn.dataset.fontDelete}`) { state.fontFamily = 'serif'; localStorage.setItem('fontFamily', state.fontFamily); } state.fonts = await DB.all('fonts'); renderPanel(); if (state.currentBook) repaginateKeepPosition(); toast('字體已刪除'); }));
  $$('.slp-bt[data-sleep]').forEach(btn => btn.addEventListener('click', () => setSleepTimer(Number(btn.dataset.sleep))));
  $('#panelFontInput')?.addEventListener('change', async e => { const file = e.target.files[0]; if (file) { await FontManager.import(file); renderPanel(); repaginateKeepPosition(); toast('字體已匯入並套用'); } });
  $('#speechRate')?.addEventListener('input', e => { localStorage.setItem('speechRate', e.target.value); $('.spd-val').textContent = `${Number(e.target.value).toFixed(1)}×`; });
  $('#clearCaches')?.addEventListener('click', async () => { await UpdateManager.disableServiceWorkerCache(); toast('已清除網頁快取'); });
}
function bindEvents() {
  $$('#themeBtn').forEach(btn => btn.addEventListener('click', () => { setTheme(state.theme === 'dark' ? 'light' : 'dark'); render(); }));
  $('#refreshBtn')?.addEventListener('click', async () => { toast('清除快取並載入最新版…'); await UpdateManager.forceNetworkReload(); });
  $('#topImportBtn')?.addEventListener('click', () => $('#bookInput')?.click());
  $('#fab')?.addEventListener('click', () => $('#bookInput')?.click());
  $('#bookInput')?.addEventListener('change', e => [...e.target.files].forEach(importBook));
  $('#emptyImport')?.addEventListener('change', e => [...e.target.files].forEach(importBook));
  $$('[data-open]').forEach(row => row.addEventListener('click', e => { if (e.target.closest('[data-delete]')) return; openBook(row.dataset.open); }));
  $$('[data-delete]').forEach(btn => btn.addEventListener('click', async e => { e.stopPropagation(); await DB.delete('books', btn.dataset.delete); state.books = (await DB.all('books')).map(TxtParser.enrichBook); render(); }));
  $('#backBtn')?.addEventListener('click', async () => { tts.stop(); state.books = (await DB.all('books')).map(TxtParser.enrichBook); state.view = 'library'; render(); });
  $('#rbook')?.addEventListener(window.PointerEvent ? 'pointerup' : 'click', handleReaderTap);
  $('#rbook')?.addEventListener('dblclick', e => e.preventDefault());
  $('#rbook')?.addEventListener('touchstart', e => { if (e.touches.length > 1 && e.cancelable) e.preventDefault(); }, { passive: false });
  $('#tocBtn')?.addEventListener('click', () => openPanel('toc'));
  $('#setBtn')?.addEventListener('click', () => openPanel('settings'));
  $('#rfPlay')?.addEventListener('click', () => tts.state === 'playing' ? tts.pause() : tts.play());
  $('#rfStop')?.addEventListener('click', () => tts.stop());
  $('#fontMinus')?.addEventListener('click', () => { state.fontSize = Math.max(16, state.fontSize - 2); localStorage.setItem('fontSize', state.fontSize); repaginateKeepPosition(); });
  $('#fontPlus')?.addEventListener('click', () => { state.fontSize = Math.min(34, state.fontSize + 2); localStorage.setItem('fontSize', state.fontSize); repaginateKeepPosition(); });
  $('#rfProg')?.addEventListener('click', e => { const r = e.currentTarget.getBoundingClientRect(); state.currentPage = Math.round(((e.clientX - r.left) / r.width) * (state.pages.length - 1)); renderPage(); });
}

async function render() {
  document.documentElement.dataset.theme = state.theme;
  $('#app').innerHTML = state.view === 'reader' ? readerTemplate() : libraryTemplate();
  bindEvents();
  if (state.view === 'reader') { renderPage(); renderPanel(); }
}
async function boot() {
  setTheme(state.theme);
  await render();
  UpdateManager.disableServiceWorkerCache().catch(err => console.warn('cache cleanup skipped', err));
  try {
    state.fonts = await FontManager.loadStoredFonts();
    restoreSleepTimer();
    state.books = (await DB.all('books')).map(TxtParser.enrichBook);
    await render();
  } catch (err) {
    console.warn('persistent storage unavailable, running in transient mode', err);
    toast('本機儲存暫時不可用，仍可先檢視介面');
  }
}
window.addEventListener('resize', () => { if (state.view === 'reader' && state.currentBook) repaginateKeepPosition(); });
boot().catch(err => { console.error(err); toast(`啟動失敗：${err.message}`); });
