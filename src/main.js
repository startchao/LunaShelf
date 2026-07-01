import './style.css';

const APP_VERSION = '0.1.0-20260701';
const DB_NAME = 'lunashelf-db';
const DB_VERSION = 1;
const stores = ['books', 'fonts', 'settings'];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const state = {
  books: [],
  currentBook: null,
  theme: localStorage.getItem('theme') || 'dark',
  fontFamily: localStorage.getItem('fontFamily') || 'system',
  fontSize: Number(localStorage.getItem('fontSize') || 20),
  lineHeight: Number(localStorage.getItem('lineHeight') || 1.8),
  view: 'library',
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
  static forceNetworkReload() {
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
    const candidates = ['utf-8', 'big5', 'gbk'];
    for (const enc of candidates) {
      try {
        const text = new TextDecoder(enc, { fatal: enc === 'utf-8' }).decode(buf);
        if (text && !/\uFFFD{3,}/.test(text)) return TxtParser.normalize(text);
      } catch (_) { /* try next */ }
    }
    return TxtParser.normalize(new TextDecoder('utf-8').decode(buf));
  }
  static normalize(text) {
    return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  }
  static chapters(text) {
    const re = /^\s*(第[一二三四五六七八九十百千萬万零〇0-9]+[章回節节卷部].{0,36}|Chapter\s+\d+.{0,36})\s*$/gmi;
    const found = [];
    let m;
    while ((m = re.exec(text))) found.push({ title: m[1].trim(), index: m.index });
    return found.length ? found : [{ title: '全文', index: 0 }];
  }
}

class AudioSessionManager {
  constructor() {
    this.audio = null;
    this.objectUrl = null;
  }
  makeSilentWavUrl() {
    const sampleRate = 8000;
    const seconds = 0.25;
    const samples = sampleRate * seconds;
    const buffer = new ArrayBuffer(44 + samples * 2);
    const view = new DataView(buffer);
    const write = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
    write(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); write(8, 'WAVE');
    write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    write(36, 'data'); view.setUint32(40, samples * 2, true);
    const blob = new Blob([buffer], { type: 'audio/wav' });
    return URL.createObjectURL(blob);
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
      navigator.mediaSession.metadata = new MediaMetadata({ title: book?.title || 'LunaShelf', artist: 'LunaShelf', album: 'TXT Reader' });
      navigator.mediaSession.playbackState = 'playing';
      navigator.mediaSession.setActionHandler('play', () => tts.play());
      navigator.mediaSession.setActionHandler('pause', () => tts.pause());
      navigator.mediaSession.setActionHandler('stop', () => tts.stop());
      navigator.mediaSession.setActionHandler('seekbackward', () => moveReader(-600));
      navigator.mediaSession.setActionHandler('seekforward', () => moveReader(600));
    }
  }
  stop() {
    if (this.audio) this.audio.pause();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  }
  destroy() {
    this.stop();
    if (this.audio) this.audio.remove();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.audio = null;
    this.objectUrl = null;
  }
}

class SpeechQueue {
  constructor() {
    this.state = 'idle';
    this.queueSize = 8;
    this.maxChars = 900;
    this.nextIndex = 0;
    this.currentEnd = 0;
    this.pending = new Set();
    this.audioSession = new AudioSessionManager();
  }
  splitFrom(text, start) {
    let end = Math.min(text.length, start + this.maxChars);
    const window = text.slice(start, end);
    const cut = Math.max(window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'), window.lastIndexOf('\n'));
    if (cut > 120) end = start + cut + 1;
    return { chunk: text.slice(start, end).trim(), end };
  }
  makeUtterance(chunk, start, end) {
    const u = new SpeechSynthesisUtterance(chunk);
    const voices = speechSynthesis.getVoices();
    const zh = voices.find(v => /zh|cmn|han/i.test(`${v.lang} ${v.name}`));
    if (zh) u.voice = zh;
    u.lang = zh?.lang || 'zh-TW';
    u.rate = Number(localStorage.getItem('speechRate') || 1);
    u.pitch = 1;
    u.onstart = () => { this.currentEnd = start; highlightAt(start); };
    u.onboundary = ev => { if (Number.isFinite(ev.charIndex)) highlightAt(start + ev.charIndex); };
    u.onend = () => { this.pending.delete(u); this.currentEnd = end; saveProgress(end); this.fill(); };
    u.onerror = () => { this.pending.delete(u); this.fill(); };
    return u;
  }
  async play() {
    if (!state.currentBook) return toast('請先開啟一本 TXT');
    if (this.state === 'playing') return;
    this.state = 'playing';
    this.nextIndex = state.currentBook.progress || getReaderCursor();
    await this.audioSession.start(state.currentBook);
    speechSynthesis.cancel();
    this.pending.clear();
    this.fill();
    renderTtsState();
  }
  fill() {
    if (this.state !== 'playing' || !state.currentBook) return;
    while (this.pending.size < this.queueSize && this.nextIndex < state.currentBook.content.length) {
      const { chunk, end } = this.splitFrom(state.currentBook.content, this.nextIndex);
      if (!chunk) { this.nextIndex = end + 1; continue; }
      const u = this.makeUtterance(chunk, this.nextIndex, end);
      this.pending.add(u);
      this.nextIndex = end;
      speechSynthesis.speak(u);
    }
    if (!this.pending.size && this.nextIndex >= state.currentBook.content.length) this.stop();
  }
  pause() {
    this.state = 'paused';
    this.audioSession.stop();
    speechSynthesis.cancel();
    this.pending.clear();
    saveProgress(this.currentEnd || getReaderCursor());
    renderTtsState();
  }
  stop() {
    this.state = 'idle';
    this.audioSession.stop();
    speechSynthesis.cancel();
    this.pending.clear();
    saveProgress(this.currentEnd || getReaderCursor());
    renderTtsState();
  }
}

const tts = new SpeechQueue();

function toast(msg) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = msg;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 2600);
}

function setTheme(theme) {
  state.theme = theme;
  localStorage.setItem('theme', theme);
  document.documentElement.dataset.theme = theme;
}

async function importBook(file) {
  if (!file.name.toLowerCase().endsWith('.txt')) return toast('目前先支援 TXT');
  const content = await TxtParser.parse(file);
  const book = { id: uid(), title: file.name.replace(/\.txt$/i, ''), fileName: file.name, content, chapters: TxtParser.chapters(content), progress: 0, createdAt: Date.now(), updatedAt: Date.now() };
  await DB.put('books', book);
  state.books = await DB.all('books');
  render();
  toast(`已匯入：${book.title}`);
}

async function saveProgress(index) {
  if (!state.currentBook) return;
  state.currentBook.progress = Math.max(0, Math.min(index, state.currentBook.content.length));
  state.currentBook.updatedAt = Date.now();
  await DB.put('books', state.currentBook);
}

function getReaderCursor() {
  const reader = $('.reader-text');
  return Number(reader?.dataset.cursor || state.currentBook?.progress || 0);
}

function renderTextFrom(index) {
  if (!state.currentBook) return;
  const cursor = Math.max(0, Math.min(index, state.currentBook.content.length));
  const text = state.currentBook.content.slice(cursor, cursor + 9000);
  const reader = $('.reader-text');
  if (!reader) return;
  reader.dataset.cursor = String(cursor);
  reader.textContent = text;
  reader.style.fontFamily = getFontCss();
  reader.style.fontSize = `${state.fontSize}px`;
  reader.style.lineHeight = String(state.lineHeight);
  $('.progress-label').textContent = `${Math.round((cursor / state.currentBook.content.length) * 100)}%`;
  saveProgress(cursor);
}

function highlightAt(index) {
  const reader = $('.reader-text');
  if (!reader || !state.currentBook) return;
  const cursor = getReaderCursor();
  if (index < cursor || index > cursor + 8500) renderTextFrom(index);
  else $('.progress-label').textContent = `${Math.round((index / state.currentBook.content.length) * 100)}%`;
}

function moveReader(delta) {
  if (!state.currentBook) return;
  tts.stop();
  renderTextFrom(getReaderCursor() + delta);
}

function getFontCss() {
  if (state.fontFamily === 'system') return 'var(--font-system)';
  if (state.fontFamily === 'serif') return 'var(--font-serif)';
  return `'${state.fontFamily}'`;
}

function renderTtsState() {
  const btn = $('.play-btn');
  if (btn) btn.textContent = tts.state === 'playing' ? '暫停' : '播放';
}

function libraryTemplate() {
  return `
    <header class="topbar"><div><h1>LunaShelf</h1><p>TXT-first 個人小說閱讀器 · v${APP_VERSION}</p></div><div class="top-actions"><button id="refreshBtn">強制更新</button><button id="themeBtn">${state.theme === 'dark' ? '白天' : '夜晚'}</button></div></header>
    <main class="library">
      <section class="hero"><h2>書庫</h2><p>${state.books.length} 本 · 不註冊、不雲端、不使用 Service Worker 快取</p><label class="primary">＋ 匯入 TXT<input id="bookInput" type="file" accept=".txt,text/plain" hidden></label></section>
      <section class="toolbar"><label>匯入字體<input id="fontInput" type="file" accept=".ttf,.otf,.woff,.woff2,font/*" hidden></label><select id="fontSelect"><option value="system">系統字體</option><option value="serif">明體/襯線</option></select><button id="clearCaches">清除網頁快取</button></section>
      <section class="book-grid">${state.books.map(book => `<article class="book-card" data-id="${book.id}"><b>${book.title}</b><span>${Math.round((book.progress || 0) / book.content.length * 100)}%</span><small>${new Date(book.createdAt).toLocaleDateString('zh-TW')}</small><button data-open="${book.id}">開啟</button><button class="danger" data-delete="${book.id}">刪除</button></article>`).join('') || '<div class="empty">書庫空空如也，先匯入一本 TXT。</div>'}</section>
    </main>`;
}

function readerTemplate() {
  const book = state.currentBook;
  return `
    <header class="reader-head"><button id="backBtn">← 書庫</button><div><b>${book.title}</b><span class="progress-label">0%</span></div><button id="themeBtn">${state.theme === 'dark' ? '白天' : '夜晚'}</button></header>
    <main class="reader-shell"><article class="reader-text"></article></main>
    <footer class="reader-controls"><button onclick="void 0" id="prevBtn">前移</button><button class="play-btn" id="playBtn">播放</button><button id="nextBtn">後移</button><label>字級 <input id="fontSize" type="range" min="16" max="34" value="${state.fontSize}"></label><label>行高 <input id="lineHeight" type="range" min="1.4" max="2.4" step="0.1" value="${state.lineHeight}"></label></footer>`;
}

async function populateFontSelect() {
  const select = $('#fontSelect');
  if (!select) return;
  const fonts = await DB.all('fonts');
  for (const f of fonts) select.insertAdjacentHTML('beforeend', `<option value="custom-${f.id}">${f.name}</option>`);
  select.value = state.fontFamily;
}

function bindEvents() {
  $('#themeBtn')?.addEventListener('click', () => { setTheme(state.theme === 'dark' ? 'light' : 'dark'); render(); });
  $('#refreshBtn')?.addEventListener('click', () => UpdateManager.forceNetworkReload());
  $('#clearCaches')?.addEventListener('click', async () => { await UpdateManager.disableServiceWorkerCache(); toast('已清除 CacheStorage 並停用 Service Worker'); });
  $('#bookInput')?.addEventListener('change', e => [...e.target.files].forEach(importBook));
  $('#fontInput')?.addEventListener('change', async e => { const file = e.target.files[0]; if (file) { await FontManager.import(file); render(); toast('字體已匯入並套用'); } });
  $('#fontSelect')?.addEventListener('change', e => { state.fontFamily = e.target.value; localStorage.setItem('fontFamily', state.fontFamily); });
  $$('[data-open]').forEach(btn => btn.addEventListener('click', async () => { state.currentBook = await DB.get('books', btn.dataset.open); state.view = 'reader'; render(); }));
  $$('[data-delete]').forEach(btn => btn.addEventListener('click', async () => { await DB.delete('books', btn.dataset.delete); state.books = await DB.all('books'); render(); }));
  $('#backBtn')?.addEventListener('click', async () => { tts.stop(); state.books = await DB.all('books'); state.view = 'library'; render(); });
  $('#playBtn')?.addEventListener('click', () => tts.state === 'playing' ? tts.pause() : tts.play());
  $('#prevBtn')?.addEventListener('click', () => moveReader(-1200));
  $('#nextBtn')?.addEventListener('click', () => moveReader(1200));
  $('#fontSize')?.addEventListener('input', e => { state.fontSize = Number(e.target.value); localStorage.setItem('fontSize', state.fontSize); renderTextFrom(getReaderCursor()); });
  $('#lineHeight')?.addEventListener('input', e => { state.lineHeight = Number(e.target.value); localStorage.setItem('lineHeight', state.lineHeight); renderTextFrom(getReaderCursor()); });
}

async function render() {
  document.documentElement.dataset.theme = state.theme;
  $('#app').innerHTML = state.view === 'reader' ? readerTemplate() : libraryTemplate();
  bindEvents();
  if (state.view === 'library') await populateFontSelect();
  if (state.view === 'reader') renderTextFrom(state.currentBook.progress || 0);
}

async function boot() {
  setTheme(state.theme);
  await render();
  UpdateManager.disableServiceWorkerCache().catch(err => console.warn('cache cleanup skipped', err));
  try {
    await FontManager.loadStoredFonts();
    state.books = await DB.all('books');
    await render();
  } catch (err) {
    console.warn('persistent storage unavailable, running in transient mode', err);
    toast('本機儲存暫時不可用，仍可先檢視介面');
  }
}

boot().catch(err => { console.error(err); toast(`啟動失敗：${err.message}`); });
