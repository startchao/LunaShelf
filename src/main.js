import './style.css';
import { TtsPlaybackGeneration } from './tts-playback-generation.js';
import {
  createBookBlockElement,
  isMarkdownFileName,
  isSupportedBookFileName,
  markdownToBookData,
  stripBookExtension,
} from './markdown.js';
import { getTableLayoutPresentation, normalizeTableLayoutMode } from './table-layout.js';
import {
  loadReadingPresets,
  readingMarginCss,
  saveReadingPreset,
  setActiveReadingPreset,
} from './reading-presets.js';

const APP_VERSION = '0.6.1-library-categories';
const TTS_RATE_MIN = 0.5;
const TTS_RATE_MAX = 2.5;
const TTS_RATE_PRESET_VERSION = 'v0.4.12';
if (localStorage.getItem('ttsRatePresetVersion') !== TTS_RATE_PRESET_VERSION) {
  localStorage.setItem('speechRate', String(TTS_RATE_MAX));
  localStorage.removeItem('ttsDiagPreset');
  localStorage.removeItem('ttsDiagRestoreRate');
  localStorage.removeItem('ttsDiagLast');
  localStorage.setItem('ttsRatePresetVersion', TTS_RATE_PRESET_VERSION);
}
const LAYOUT_PRESET_VERSION = 'v0.4.0';
if (localStorage.getItem('layoutPresetVersion') !== LAYOUT_PRESET_VERSION) {
  if (!localStorage.getItem('fontSize')) localStorage.setItem('fontSize', '18');
  if (!localStorage.getItem('lineHeight')) localStorage.setItem('lineHeight', '1.3');
  if (!localStorage.getItem('paragraphSpacing')) localStorage.setItem('paragraphSpacing', '0.5');
  localStorage.setItem('layoutPresetVersion', LAYOUT_PRESET_VERSION);
}
const DB_NAME = 'lunashelf-db';
const DB_VERSION = 1;
const initialReadingPresets = loadReadingPresets(localStorage);
const initialReadingLayout = initialReadingPresets.presets[initialReadingPresets.activeId];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = {
  books: [],
  fonts: [],
  currentBook: null,
  theme: localStorage.getItem('theme') || 'light',
  readingPresetMode: initialReadingPresets.activeId,
  readingPresets: initialReadingPresets.presets,
  fontFamily: initialReadingLayout.fontFamily,
  fontSize: initialReadingLayout.fontSize,
  lineHeight: initialReadingLayout.lineHeight,
  paragraphSpacing: initialReadingLayout.paragraphSpacing,
  marginPreset: initialReadingLayout.marginPreset,
  tableLayoutMode: normalizeTableLayoutMode(initialReadingLayout.tableLayoutMode),
  ttsVolume: Number(localStorage.getItem('ttsVolume') || 1),
  wakeLockStatus: 'idle',
  libraryCategory: localStorage.getItem('libraryCategory') || 'all',
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
    persistCurrentReadingLayout();
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
    if (book.format === 'markdown' || isMarkdownFileName(book.fileName)) {
      const parsed = markdownToBookData(book.content || '');
      book.format = 'markdown';
      book.blocks = parsed.blocks;
      book.paragraphs = parsed.paragraphs;
      book.chapters = parsed.chapters.length ? parsed.chapters : [{ title: '全文', idx: 0 }];
      return book;
    }
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

class WakeLockManager {
  constructor() { this.sentinel = null; }
  isSupported() { return 'wakeLock' in navigator && typeof navigator.wakeLock?.request === 'function'; }
  async request() {
    if (!this.isSupported()) { state.wakeLockStatus = 'unsupported'; renderTtsState(); return false; }
    if (document.visibilityState !== 'visible') { state.wakeLockStatus = 'background'; renderTtsState(); return false; }
    try {
      if (!this.sentinel || this.sentinel.released) {
        this.sentinel = await navigator.wakeLock.request('screen');
        this.sentinel.addEventListener('release', () => {
          state.wakeLockStatus = 'released';
          renderTtsState();
          renderPanel();
        });
      }
      state.wakeLockStatus = 'active';
      renderTtsState();
      renderPanel();
      return true;
    } catch (err) {
      console.warn('wake lock unavailable', err);
      state.wakeLockStatus = 'error';
      renderTtsState();
      renderPanel();
      return false;
    }
  }
  async release() {
    try { if (this.sentinel && !this.sentinel.released) await this.sentinel.release(); } catch (_) { /* ignore */ }
    this.sentinel = null;
    state.wakeLockStatus = 'idle';
    renderTtsState();
    renderPanel();
  }
}

const wakeLock = new WakeLockManager();

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
  ensureAudio() {
    if (this.audio) return;
    this.objectUrl = this.makeSilentWavUrl();
    this.audio = new Audio(this.objectUrl);
    this.audio.loop = true;
    this.audio.playsInline = true;
    this.audio.preload = 'auto';
    this.audio.setAttribute('aria-hidden', 'true');
    document.body.appendChild(this.audio);
  }
  async start(book) {
    this.ensureAudio();
    this.audio.volume = state.ttsVolume;
    try { await this.audio.play(); } catch (err) { console.warn('Audio session start blocked', err); }
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: book?.title || '月閣', artist: 'LunaShelf', album: 'TXT / Markdown Reader' });
      navigator.mediaSession.playbackState = 'playing';
      // Media Session play is an explicit user/system command, so it follows the
      // same clean-generation path as the on-screen Play button.
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
    this.activeSegment = null;
    this.resumePara = null;
    this.playback = new TtsPlaybackGeneration();
    this.audioSession = new AudioSessionManager();
    this.startWatchdog = null;
    this.sessionVoice = null;
  }
  isSupported() { return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window; }
  pickVoice() {
    const voices = speechSynthesis.getVoices();
    const savedVoiceURI = localStorage.getItem('speechVoiceURI');
    if (savedVoiceURI === '__auto__') return null;
    return voices.find(v => savedVoiceURI && v.voiceURI === savedVoiceURI)
      || voices.find(v => /zh-TW|zh_Hant|cmn-Hant|Taiwan/i.test(`${v.lang} ${v.name}`))
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
  makeUtterance(text, paraIdx, generation) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-TW';
    if (this.sessionVoice) u.voice = this.sessionVoice;
    u.rate = clampSpeechRate(localStorage.getItem('speechRate'));
    u.pitch = 1;
    u.volume = state.ttsVolume;
    u.onstart = () => {
      if (!this.playback.isCurrent(u, generation) || this.state !== 'playing') return;
      clearTimeout(this.startWatchdog);
      highlightPara(paraIdx);
    };
    u.onend = () => {
      if (!this.playback.clear(u, generation) || this.state !== 'playing') return;
      this.currentUtterance = null;
      this.activeSegment = null;
      this.nextPara = Math.max(this.nextPara, paraIdx + 1);
      this.resumePara = this.nextPara;
      saveProgressFromPage();
      this.speakNext(generation);
    };
    u.onerror = ev => {
      if (!this.playback.clear(u, generation) || this.state !== 'playing') return;
      console.warn('TTS error', ev.error || ev);
      this.currentUtterance = null;
      if (['interrupted', 'canceled'].includes(ev.error)) {
        // External interruption ends this generation. Only a later explicit
        // Play may create another utterance.
        this.resumePara = paraIdx;
        this.state = 'idle';
        this.activeSegment = null;
        this.audioSession.stop();
        wakeLock.release().catch(() => {});
        renderTtsState();
        return;
      }
      this.activeSegment = null;
      this.nextPara = Math.max(this.nextPara, paraIdx + 1);
      this.resumePara = this.nextPara;
      this.speakNext(generation);
    };
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
  prepareFrom(startPara) {
    this.nextPara = Math.max(0, startPara || 0);
    this.segments = this.buildSegments(this.nextPara);
    this.segmentIndex = 0;
    this.activeSegment = null;
  }
  invalidateSpeechState() {
    clearTimeout(this.startWatchdog);
    this.startWatchdog = null;
    const oldUtterance = this.currentUtterance;
    const generation = this.playback.begin();
    // Detach first: iOS may dispatch canceled/interrupted after cancel() returns.
    if (oldUtterance) {
      oldUtterance.onstart = null;
      oldUtterance.onend = null;
      oldUtterance.onerror = null;
    }
    this.currentUtterance = null;
    return generation;
  }
  cancelSpeechEngine() {
    const generation = this.invalidateSpeechState();
    speechSynthesis.cancel();
    return generation;
  }
  play() {
    if (!state.currentBook) return toast('請先開啟一本書');
    if (!this.isSupported()) return toast('這個瀏覽器不支援朗讀，請用 Safari/Edge/Chrome 測試');
    if (this.state === 'playing') return;
    const startPara = this.resumePara
      ?? state.pages[state.currentPage]?.startPara
      ?? state.currentBook.progressPara
      ?? 0;
    // Background, Pause, and Stop already canceled the old native session.
    // Do not cancel again here: affected WebKit builds may deliver that cancel
    // asynchronously and clear the fresh utterance queued below (WebKit #191745).
    const generation = this.invalidateSpeechState();
    // Resolve once per explicit Play so iOS cannot switch voices mid-session.
    this.sessionVoice = this.pickVoice();
    this.prepareFrom(startPara);
    this.resumePara = startPara;
    this.state = 'playing';
    renderTtsState();
    this.speakNext(generation); // Keep first speak inside the user activation.
    this.audioSession.start(state.currentBook).catch(err => console.warn('Audio session start blocked', err));
    wakeLock.request().catch(err => console.warn('wake lock request failed', err));
  }
  armStartWatchdog(utterance, generation) {
    clearTimeout(this.startWatchdog);
    this.startWatchdog = setTimeout(() => {
      if (!this.playback.isCurrent(utterance, generation) || this.state !== 'playing') return;
      if (speechSynthesis.speaking || speechSynthesis.pending) return;
      this.resumePara = this.activeSegment?.paraIdx ?? this.nextPara;
      this.state = 'idle';
      this.invalidateSpeechState();
      this.activeSegment = null;
      this.audioSession.stop();
      wakeLock.release().catch(() => {});
      renderTtsState();
      toast('朗讀未啟動，請再點一次播放');
    }, 1400);
  }
  speakNext(generation) {
    const book = state.currentBook;
    if (this.state !== 'playing' || generation !== this.playback.value || !book) return;
    const seg = this.segments[this.segmentIndex++];
    if (!seg) return this.stop();
    this.nextPara = seg.paraIdx;
    this.resumePara = seg.paraIdx;
    this.activeSegment = seg;
    const utterance = this.makeUtterance(seg.text, seg.paraIdx, generation);
    this.currentUtterance = utterance;
    if (!this.playback.set(utterance, generation)) return;
    speechSynthesis.speak(utterance);
    this.armStartWatchdog(utterance, generation);
  }
  suspendForBackground() {
    if (this.state !== 'playing') return;
    this.resumePara = this.activeSegment?.paraIdx ?? this.nextPara;
    this.state = 'idle';
    this.cancelSpeechEngine();
    this.activeSegment = null;
    this.audioSession.stop();
    wakeLock.release().catch(() => {});
    renderTtsState();
    saveProgressFromPage();
  }
  pause() {
    this.resumePara = this.activeSegment?.paraIdx ?? this.nextPara;
    this.state = 'paused';
    this.cancelSpeechEngine();
    this.activeSegment = null;
    this.audioSession.stop();
    wakeLock.release().catch(() => {});
    renderTtsState();
    saveProgressFromPage();
  }
  stop() {
    this.state = 'idle';
    this.cancelSpeechEngine();
    this.resumePara = null;
    this.activeSegment = null;
    this.segments = [];
    this.audioSession.stop();
    wakeLock.release().catch(() => {});
    renderTtsState();
    saveProgressFromPage();
  }
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
  if (state.fontFamily === 'english-serif') return 'var(--font-english-serif)';
  return `'${state.fontFamily}'`;
}
function getParagraphGapEm() {
  return `${Math.max(0, state.paragraphSpacing) * Math.max(1, state.lineHeight)}em`;
}
function clampTtsVolume(value) {
  return Math.max(0.1, Math.min(1, Number(value) || 1));
}
function clampSpeechRate(value) {
  return Math.max(TTS_RATE_MIN, Math.min(TTS_RATE_MAX, Number(value) || 1));
}
function setTtsVolume(value, persist = true) {
  state.ttsVolume = clampTtsVolume(value);
  if (persist) localStorage.setItem('ttsVolume', String(state.ttsVolume));
  if (tts?.currentUtterance) tts.currentUtterance.volume = state.ttsVolume;
  if (tts?.audioSession?.audio) tts.audioSession.audio.volume = state.ttsVolume;
  const slider = $('#speechVolume');
  const label = $('#speechVolumeVal');
  if (slider) slider.value = String(state.ttsVolume);
  if (label) label.textContent = `${Math.round(state.ttsVolume * 100)}%`;
}
function bookProgress(book) {
  const total = book.paragraphs?.length || 1;
  return Math.round(((book.progressPara || 0) / Math.max(1, total - 1)) * 100);
}
function bookCoverColor(title) {
  const colors = ['#123c33', '#321047', '#503516', '#17344f', '#4a1d24'];
  const n = [...String(title || '')].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  return colors[n % colors.length];
}
function bookReadTime(book) {
  return Number(book.lastReadAt || (book.progressPara ? book.updatedAt : 0) || 0);
}
function isReadingBook(book) {
  return Boolean(bookReadTime(book) || (book.progressPara || 0) > 0);
}
function sortedLibraryBooks() {
  return [...state.books].sort((a, b) => {
    const ar = isReadingBook(a) ? 1 : 0;
    const br = isReadingBook(b) ? 1 : 0;
    if (ar !== br) return br - ar;
    if (ar && br) return bookReadTime(b) - bookReadTime(a);
    return Number(b.createdAt || b.updatedAt || 0) - Number(a.createdAt || a.updatedAt || 0);
  });
}

async function importBook(file) {
  if (!isSupportedBookFileName(file.name)) return toast('支援 TXT、MD 與 MARKDOWN 檔案');
  const content = await TxtParser.parse(file);
  const markdown = isMarkdownFileName(file.name);
  const paragraphs = markdown ? undefined : TxtParser.paragraphs(content);
  const book = TxtParser.enrichBook({ id: uid(), title: stripBookExtension(file.name), fileName: file.name, format: markdown ? 'markdown' : 'txt', content, paragraphs, progressPara: 0, createdAt: Date.now(), updatedAt: Date.now() });
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

function applyReaderTypography(node) {
  if (!node) return;
  node.style.fontSize = `${state.fontSize}px`;
  node.style.lineHeight = String(state.lineHeight);
  node.style.fontFamily = getFontCss();
  node.style.setProperty('--para-gap', getParagraphGapEm());
  node.classList.toggle('reading-preset-english', state.readingPresetMode === 'english');
  if (state.readingPresetMode === 'english') node.setAttribute('lang', 'en');
  else node.removeAttribute('lang');
  const margin = readingMarginCss(state.marginPreset);
  node.style.setProperty('--page-margin-x', margin);
  node.closest('.rpage')?.style.setProperty('--page-margin-x', margin);
}

function currentReadingLayout() {
  return {
    fontFamily: state.fontFamily,
    fontSize: state.fontSize,
    lineHeight: state.lineHeight,
    paragraphSpacing: state.paragraphSpacing,
    marginPreset: state.marginPreset,
    tableLayoutMode: state.tableLayoutMode,
  };
}

function persistCurrentReadingLayout() {
  const saved = saveReadingPreset(localStorage, state.readingPresetMode, currentReadingLayout());
  state.readingPresets[state.readingPresetMode] = saved;
  localStorage.setItem('fontFamily', saved.fontFamily);
  localStorage.setItem('fontSize', String(saved.fontSize));
  localStorage.setItem('lineHeight', String(saved.lineHeight));
  localStorage.setItem('paragraphSpacing', String(saved.paragraphSpacing));
  localStorage.setItem('tableLayoutMode', saved.tableLayoutMode);
}

function applyReadingPresetMode(value) {
  const id = setActiveReadingPreset(localStorage, value);
  const preset = state.readingPresets[id];
  state.readingPresetMode = id;
  Object.assign(state, preset);
  persistCurrentReadingLayout();
  renderPanel();
  if (state.currentBook) repaginateKeepPosition();
  toast(id === 'english' ? '已套用英文舒讀版面' : '已套用小說閱讀版面');
}

function applyTableLayout(node) {
  if (!node) return;
  const presentation = getTableLayoutPresentation(state.tableLayoutMode);
  node.classList.remove('table-layout-standard', 'table-layout-bilingual');
  node.classList.add(presentation.className);
  node.dataset.tableLayout = presentation.mode;
}

function setTableLayoutMode(value) {
  state.tableLayoutMode = normalizeTableLayoutMode(value);
  persistCurrentReadingLayout();
  $$('.rpage').forEach(applyTableLayout);
  renderPanel();
  if (state.currentBook) repaginateKeepPosition();
}

function makeParagraph(text, idx, block) {
  return createBookBlockElement(block || { type: 'paragraph', text }, idx);
}

function createPaginationProbe() {
  const shell = document.createElement('article');
  shell.className = 'rpage page-probe';
  applyTableLayout(shell);
  shell.setAttribute('aria-hidden', 'true');
  shell.style.width = `${window.innerWidth}px`;
  shell.style.height = `${window.innerHeight}px`;
  const body = document.createElement('div');
  body.className = 'rp-body';
  applyReaderTypography(body);
  shell.appendChild(body);
  document.body.appendChild(shell);
  return { shell, body };
}

function paginate(goToPara = 0) {
  const book = state.currentBook;
  if (!book) return;
  const { shell: probe, body: probeBody } = createPaginationProbe();
  const pages = [];
  let cursor = 0;
  let targetPage = 0;
  const chapterStarts = new Set((book.chapters || []).map(ch => ch.idx));
  while (cursor < book.paragraphs.length) {
    probeBody.innerHTML = '';
    const startPara = cursor;
    let endPara = cursor;
    while (endPara < book.paragraphs.length) {
      if (endPara > startPara && chapterStarts.has(endPara)) break;
      const p = makeParagraph(book.paragraphs[endPara], endPara, book.blocks?.[endPara]);
      probeBody.appendChild(p);
      if (probeBody.scrollHeight > probeBody.clientHeight) {
        probeBody.removeChild(p);
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
  title && (title.textContent = state.currentBook.title);
  applyReaderTypography(body);
  body.innerHTML = '';
  for (let i = page.startPara; i <= page.endPara && i < state.currentBook.paragraphs.length; i++) {
    body.appendChild(makeParagraph(state.currentBook.paragraphs[i], i, state.currentBook.blocks?.[i]));
  }
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
  if (e.target.closest('.reader-head, .reader-controls, .pback, .md-table, a, button, input, select, label')) return;
  if (e.cancelable) e.preventDefault();
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
  const sleepBtn = $('#sleepBtn');
  if (sleepBtn) {
    const left = sleepMinutesLeft();
    sleepBtn.textContent = left ? `${left}` : '⏱';
    sleepBtn.classList.toggle('on', Boolean(left));
    sleepBtn.title = left ? `定時關閉：剩 ${left} 分；點擊取消` : '選擇定時關閉時間';
  }
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
    state.sleepTimer = setTimeout(() => { tts.stop(); state.sleepUntil = 0; localStorage.removeItem('sleepUntil'); toast('定時結束，已停止朗讀'); renderPanel(); renderTtsState(); }, minutes * 60000);
    toast(`已設定 ${minutes} 分鐘後停止`);
  }
  renderPanel();
  renderTtsState();
}
function restoreSleepTimer() {
  const left = state.sleepUntil - Date.now();
  if (left > 0) state.sleepTimer = setTimeout(() => { tts.stop(); state.sleepUntil = 0; localStorage.removeItem('sleepUntil'); toast('定時結束，已停止朗讀'); renderPanel(); renderTtsState(); }, left);
  else { state.sleepUntil = 0; localStorage.removeItem('sleepUntil'); }
}

function libraryTemplate() {
  const books = sortedLibraryBooks();
  const counts = { all: books.length, txt: 0, markdown: 0 };
  books.forEach(book => { counts[bookCategory(book)] += 1; });
  if (!Object.hasOwn(counts, state.libraryCategory)) state.libraryCategory = 'all';
  const visibleBooks = state.libraryCategory === 'all' ? books : books.filter(book => bookCategory(book) === state.libraryCategory);
  const recentCount = visibleBooks.filter(isReadingBook).length;
  const shelfLabel = recentCount ? `近期閱讀 ${recentCount} 本優先` : '依匯入時間排序';
  const categories = [['all', '全部'], ['txt', '小說 TXT'], ['markdown', '文件 MD']]
    .map(([id, label]) => `<button class="library-category ${state.libraryCategory === id ? 'on' : ''}" data-library-category="${id}" aria-pressed="${state.libraryCategory === id}">${label}<span>${counts[id]}</span></button>`).join('');
  const empty = books.length
    ? '<div class="bempty"><div class="bempty-ico">分類</div><div class="bempty-txt">此分類尚無檔案</div></div>'
    : '<div class="bempty"><div class="bempty-ico">書</div><div class="bempty-txt">書庫空空如也<br>上傳 TXT 或 Markdown 開始閱讀</div><label class="bempty-btn">＋ 上傳第一本書<input id="emptyImport" type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" hidden></label></div>';
  return `
    <header class="lhd"><div class="lhd-logo">月閣 <small>LunaShelf v${APP_VERSION}</small></div><button class="ibt" id="refreshBtn" aria-label="強制更新">↻</button><button class="ibt" id="themeBtn" aria-label="切換夜間">${state.theme === 'dark' ? '☀' : '🌙'}</button><button class="ibt" id="topImportBtn" aria-label="匯入 TXT 或 Markdown">＋</button></header>
    <main class="lbody">
      <div class="lbar"><span class="lbar-t">書庫</span><div class="lbar-l"></div><span class="lbar-c">${visibleBooks.length} 本 · ${shelfLabel}</span></div>
      <nav class="library-categories" aria-label="書庫分類">${categories}</nav>
      <section class="blist">${visibleBooks.map(bookRow).join('') || empty}</section>
    </main>
    <button class="fab" id="fab" aria-label="上傳書籍">＋</button><input id="bookInput" type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" hidden>`;
}
function bookCategory(book) {
  return book.format === 'markdown' || isMarkdownFileName(book.fileName) ? 'markdown' : 'txt';
}
function bookRow(book) {
  const pct = bookProgress(book);
  const reading = isReadingBook(book);
  const pill = reading ? `近期閱讀 · ${pct}%` : `開始閱讀 ${pct}%`;
  return `<article class="brow ${reading ? 'recent' : ''}" data-open="${book.id}"><div class="brow-cov" style="background:${bookCoverColor(book.title)}"><span>${esc(book.title)}</span></div><div class="brow-info"><button class="brow-del" data-delete="${book.id}" aria-label="刪除">×</button><div class="brow-title">${esc(book.title)}</div><div class="brow-meta"><span>${book.chapters?.length || 1} 章</span><span>${book.paragraphs?.length || 0} 段</span>${reading ? '<span>最近讀</span>' : ''}</div><div class="brow-prog-wrap"><div class="brow-prog"><div class="brow-prog-f" style="width:${pct}%"></div></div><span class="brow-pct">${pct}%</span></div><span class="brow-pill">${pill}</span></div></article>`;
}
function readerTemplate() {
  const book = state.currentBook;
  const tableLayout = getTableLayoutPresentation(state.tableLayoutMode);
  return `
    <section class="reader-view">
      <header class="reader-head ${state.toolbarOn ? 'show' : ''}"><button class="rbk" id="backBtn">◀ 書庫</button><div class="rtitle">${esc(book.title)}</div><div class="rtool"><button class="ribt" id="tocBtn">☰</button><button class="ribt" id="setBtn">⚙</button></div></header>
      <main class="rbook" id="rbook"><div class="tap-zone zone-left" id="zoneLeft"></div><div class="tap-zone zone-mid" id="zoneMid"></div><div class="tap-zone zone-right" id="zoneRight"></div><article class="rpage ${tableLayout.className}" data-table-layout="${tableLayout.mode}"><div class="rp-body"></div><footer class="rp-foot"><span class="rp-num">…</span></footer></article></main>
      <footer class="reader-controls ${state.toolbarOn ? 'show' : ''}"><button class="rfbt" id="rfPlay" aria-label="播放/暫停">▶</button><button class="rfbt" id="rfStop" aria-label="停止">⏹</button><button class="rfbt" id="sleepBtn" aria-label="定時關閉">⏱</button><div class="rf-div"></div><button class="rfbt" id="bottomTocBtn" aria-label="目錄">☰</button><button class="rfbt" id="bottomSetBtn" aria-label="設定">⚙</button><button class="rftog" id="themeBtn" aria-label="日夜切換">${state.theme === 'dark' ? '☀' : '🌙'}</button><div class="rf-div"></div><button class="rffont" id="fontMinus">A−</button><button class="rffont" id="fontPlus">A+</button><div class="rf-prog-wrap"><div class="rf-prog" id="rfProg"><div class="rf-prog-f"></div></div><span class="rf-pct">0%</span></div></footer>
      <div id="panelRoot"></div>
    </section>`;
}
function ttsVoiceOptions() {
  const selected = localStorage.getItem('speechVoiceURI') || '';
  const voices = 'speechSynthesis' in window ? speechSynthesis.getVoices() : [];
  const chineseVoices = voices.filter(v => /zh|cmn|han/i.test(`${v.lang} ${v.name}`));
  const options = chineseVoices.map(v => `<option value="${esc(v.voiceURI)}" ${selected === v.voiceURI ? 'selected' : ''}>${esc(v.name)}（${esc(v.lang)}）</option>`).join('');
  return `<option value="" ${selected === '' ? 'selected' : ''}>高速中文（建議）</option><option value="__auto__" ${selected === '__auto__' ? 'selected' : ''}>系統自動聲線</option>${options}`;
}
function panelTemplate() {
  if (!state.panel) return '';
  if (state.panel === 'toc') {
    const chapters = state.currentBook?.chapters || [];
    const currentChapter = state.pages[state.currentPage]?.chapterIdx ?? getChapterIndex(state.currentBook?.progressPara || 0);
    return `<div class="pback on"><div class="pov" id="panelClose"></div><div class="pbox"><div class="phd"><span class="phd-t">📖 章節目錄</span><button class="pcls" id="panelX">×</button></div><div class="pbody">${chapters.map((ch, i) => `<div class="toc-item ${i === currentChapter ? 'current' : ''}" data-chapter="${i}" ${i === currentChapter ? 'data-current-chapter="1"' : ''}><span class="toc-n">${i + 1}</span><span class="toc-t">${esc(ch.title)}</span><span class="toc-arr">›</span></div>`).join('') || '<div class="toc-empty">未偵測到章節標題</div>'}</div></div></div>`;
  }
  const importedFonts = state.fonts.map(f => `<div class="font-row"><button class="font-opt ${state.fontFamily === `custom-${f.id}` ? 'on' : ''}" data-font="custom-${f.id}">${esc(f.name)}</button><button class="font-del" data-font-delete="${f.id}" aria-label="刪除字體">×</button></div>`).join('');
  const sleepLeft = sleepMinutesLeft();
  const lineHeight = state.lineHeight.toFixed(1);
  const paragraphSpacing = state.paragraphSpacing.toFixed(1);
  const speechVolume = clampTtsVolume(state.ttsVolume);
  const speechRate = clampSpeechRate(localStorage.getItem('speechRate'));
  const sleepBtns = [10, 30, 50, 60].map(min => `<button class="slp-bt ${sleepLeft === min ? 'on' : ''}" data-sleep="${min}">${min}分</button>`).join('');
  return `<div class="pback on"><div class="pov" id="panelClose"></div><div class="pbox"><div class="phd"><span class="phd-t">⚙ 閱讀設定</span><button class="pcls" id="panelX">×</button></div><div class="pbody"><div class="sg"><div class="sg-lbl">閱讀版面（各自記憶調整）</div><div class="font-opts preset-opts"><button class="font-opt ${state.readingPresetMode === 'novel' ? 'on' : ''}" data-reading-preset="novel">小說閱讀</button><button class="font-opt ${state.readingPresetMode === 'english' ? 'on' : ''}" data-reading-preset="english">英文舒讀</button></div><div class="sg-hint">目前版面的字體、字級、行高、段距、邊距與表格模式會分開保存。</div></div><div class="sg"><div class="sg-lbl">字體</div><div class="font-opts font-builtins"><button class="font-opt ${state.fontFamily === 'serif' ? 'on' : ''}" data-font="serif">中文宋體</button><button class="font-opt ${state.fontFamily === 'english-serif' ? 'on' : ''}" data-font="english-serif">英文襯線</button><button class="font-opt ${state.fontFamily === 'system' ? 'on' : ''}" data-font="system">系統黑體</button></div><div class="font-list">${importedFonts || '<div class="sg-hint">尚未匯入自訂字體</div>'}</div><label class="font-import-btn">＋ 匯入字體<input id="panelFontInput" type="file" accept=".ttf,.otf,.woff,.woff2,font/*" hidden></label></div><div class="sg"><div class="sg-lbl">表格版面</div><div class="font-opts table-layout-opts"><button class="font-opt ${state.tableLayoutMode === 'standard' ? 'on' : ''}" data-table-layout-mode="standard" aria-pressed="${state.tableLayoutMode === 'standard'}">標準表格</button><button class="font-opt ${state.tableLayoutMode === 'bilingual' ? 'on' : ''}" data-table-layout-mode="bilingual" aria-pressed="${state.tableLayoutMode === 'bilingual'}">雙語表格</button></div><div class="sg-hint">雙語表格會將兩欄內容在手機顯示為上下對照卡片，寬螢幕則並排顯示；不影響一般文章段落。</div></div><div class="sg"><div class="sg-lbl">閱讀排版</div><div class="spd-wrap"><span class="sg-hint">字級</span><input type="range" class="spd-slider" id="fontSize" min="16" max="34" step="1" value="${state.fontSize}"><span class="spd-val" id="fontSizeVal">${state.fontSize}px</span></div><div class="spd-wrap"><span class="sg-hint">行高</span><input type="range" class="spd-slider" id="lineHeight" min="1.0" max="2.5" step="0.1" value="${lineHeight}"><span class="spd-val" id="lineHeightVal">${lineHeight}×</span></div><div class="spd-wrap"><span class="sg-hint">段距</span><input type="range" class="spd-slider" id="paragraphSpacing" min="0" max="2" step="0.1" value="${paragraphSpacing}"><span class="spd-val" id="paragraphSpacingVal">${paragraphSpacing}行</span></div><div class="sg-hint">段距以「行」為單位；0.5 行就是 tReader 預設。</div><div class="sg-lbl layout-sub-label">左右邊距</div><div class="font-opts margin-opts"><button class="font-opt ${state.marginPreset === 'narrow' ? 'on' : ''}" data-margin-preset="narrow">窄</button><button class="font-opt ${state.marginPreset === 'standard' ? 'on' : ''}" data-margin-preset="standard">標準</button><button class="font-opt ${state.marginPreset === 'wide' ? 'on' : ''}" data-margin-preset="wide">寬</button></div></div><div class="sg"><div class="sg-lbl">聽書語速</div><div class="spd-wrap"><input type="range" class="spd-slider" id="speechRate" min="${TTS_RATE_MIN}" max="${TTS_RATE_MAX}" step="0.1" value="${speechRate}"><span class="spd-val" id="speechRateVal">${speechRate.toFixed(1)}×</span></div><div class="sg-hint">顯示值會直接套用為實際朗讀速度；指定中文聲線後，最高可調至 2.5×。</div></div><div class="sg"><div class="sg-lbl">朗讀聲線</div><select class="font-opt" id="speechVoice">${ttsVoiceOptions()}</select><div class="sg-hint">「高速中文」沿用書閣的中文聲線優先策略；變更後於下次按播放時生效。</div></div><div class="sg"><div class="sg-lbl">AirPods／藍牙聽書音量</div><div class="spd-wrap"><input type="range" class="spd-slider" id="speechVolume" min="0.1" max="1" step="0.05" value="${speechVolume}"><span class="spd-val" id="speechVolumeVal">${Math.round(speechVolume * 100)}%</span></div><div class="sg-hint">若 AirPods 觸控音量無法控制網頁朗讀，請用這裡調整。此設定會套用到下一段朗讀，並盡量即時調整目前段落。</div></div><div class="sg"><div class="sg-lbl">定時關閉 ${sleepLeft ? `· 剩 ${sleepLeft} 分` : ''}</div><div class="slp-wrap">${sleepBtns}</div></div></div></div></div>`;
}
function renderPanel() {
  const root = $('#panelRoot');
  if (!root) return;
  root.innerHTML = panelTemplate();
  bindPanelEvents();
  if (state.panel === 'toc') {
    requestAnimationFrame(() => {
      $('[data-current-chapter="1"]')?.scrollIntoView({ block: 'center', behavior: 'auto' });
    });
  }
}

async function openBook(id) {
  state.currentBook = TxtParser.enrichBook(await DB.get('books', id));
  state.currentBook.lastReadAt = Date.now();
  await saveBook(state.currentBook);
  state.view = 'reader';
  state.toolbarOn = false;
  paginate(state.currentBook.progressPara || 0);
  await render();
}
function bindPanelEvents() {
  $('#panelClose')?.addEventListener('click', closePanel);
  $('#panelX')?.addEventListener('click', closePanel);
  $$('[data-chapter]').forEach(el => el.addEventListener('click', () => jumpChapter(Number(el.dataset.chapter))));
  $$('[data-reading-preset]').forEach(btn => btn.addEventListener('click', () => applyReadingPresetMode(btn.dataset.readingPreset)));
  $$('[data-font]').forEach(btn => btn.addEventListener('click', () => { state.fontFamily = btn.dataset.font; persistCurrentReadingLayout(); closePanel(); repaginateKeepPosition(); }));
  $$('[data-table-layout-mode]').forEach(btn => btn.addEventListener('click', () => setTableLayoutMode(btn.dataset.tableLayoutMode)));
  $$('[data-margin-preset]').forEach(btn => btn.addEventListener('click', () => { state.marginPreset = btn.dataset.marginPreset; persistCurrentReadingLayout(); renderPanel(); if (state.currentBook) repaginateKeepPosition(); }));
  $$('[data-font-delete]').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const deletedFamily = `custom-${btn.dataset.fontDelete}`;
    await DB.delete('fonts', btn.dataset.fontDelete);
    for (const id of ['novel', 'english']) {
      if (state.readingPresets[id].fontFamily !== deletedFamily) continue;
      state.readingPresets[id].fontFamily = id === 'english' ? 'english-serif' : 'serif';
      state.readingPresets[id] = saveReadingPreset(localStorage, id, state.readingPresets[id]);
    }
    if (state.fontFamily === deletedFamily) state.fontFamily = state.readingPresetMode === 'english' ? 'english-serif' : 'serif';
    persistCurrentReadingLayout();
    state.fonts = await DB.all('fonts');
    renderPanel();
    if (state.currentBook) repaginateKeepPosition();
    toast('字體已刪除');
  }));
  $$('.slp-bt[data-sleep]').forEach(btn => btn.addEventListener('click', () => setSleepTimer(Number(btn.dataset.sleep))));
  $('#panelFontInput')?.addEventListener('change', async e => { const file = e.target.files[0]; if (file) { await FontManager.import(file); renderPanel(); repaginateKeepPosition(); toast('字體已匯入並套用'); } });
  $('#speechRate')?.addEventListener('input', e => { localStorage.setItem('speechRate', e.target.value); $('#speechRateVal') && ($('#speechRateVal').textContent = `${Number(e.target.value).toFixed(1)}×`); });
  $('#speechVoice')?.addEventListener('change', e => {
    if (e.target.value) localStorage.setItem('speechVoiceURI', e.target.value);
    else localStorage.removeItem('speechVoiceURI');
  });
  $('#speechVolume')?.addEventListener('input', e => setTtsVolume(e.target.value));
  $('#fontSize')?.addEventListener('input', e => {
    state.fontSize = Number(e.target.value);
    persistCurrentReadingLayout();
    $('#fontSizeVal') && ($('#fontSizeVal').textContent = `${state.fontSize}px`);
    if (state.currentBook) repaginateKeepPosition();
  });
  $('#lineHeight')?.addEventListener('input', e => {
    state.lineHeight = Number(e.target.value);
    persistCurrentReadingLayout();
    $('#lineHeightVal') && ($('#lineHeightVal').textContent = `${state.lineHeight.toFixed(1)}×`);
    if (state.currentBook) repaginateKeepPosition();
  });
  $('#paragraphSpacing')?.addEventListener('input', e => {
    state.paragraphSpacing = Number(e.target.value);
    persistCurrentReadingLayout();
    $('#paragraphSpacingVal') && ($('#paragraphSpacingVal').textContent = `${state.paragraphSpacing.toFixed(1)}行`);
    if (state.currentBook) repaginateKeepPosition();
  });
  $('#clearCaches')?.addEventListener('click', async () => { await UpdateManager.disableServiceWorkerCache(); toast('已清除網頁快取'); });
}
function bindEvents() {
  $$('#themeBtn').forEach(btn => btn.addEventListener('click', () => { setTheme(state.theme === 'dark' ? 'light' : 'dark'); render(); }));
  $('#refreshBtn')?.addEventListener('click', async () => { toast('清除快取並載入最新版…'); await UpdateManager.forceNetworkReload(); });
  $('#topImportBtn')?.addEventListener('click', () => $('#bookInput')?.click());
  $('#fab')?.addEventListener('click', () => $('#bookInput')?.click());
  $('#bookInput')?.addEventListener('change', e => [...e.target.files].forEach(importBook));
  $('#emptyImport')?.addEventListener('change', e => [...e.target.files].forEach(importBook));
  $$('[data-library-category]').forEach(btn => btn.addEventListener('click', () => {
    state.libraryCategory = btn.dataset.libraryCategory;
    localStorage.setItem('libraryCategory', state.libraryCategory);
    render();
  }));
  $$('[data-open]').forEach(row => row.addEventListener('click', e => { if (e.target.closest('[data-delete]')) return; openBook(row.dataset.open); }));
  $$('[data-delete]').forEach(btn => btn.addEventListener('click', async e => { e.stopPropagation(); await DB.delete('books', btn.dataset.delete); state.books = (await DB.all('books')).map(TxtParser.enrichBook); render(); }));
  $('#backBtn')?.addEventListener('click', async () => { tts.stop(); state.books = (await DB.all('books')).map(TxtParser.enrichBook); state.view = 'library'; render(); });
  $('#rbook')?.addEventListener(window.PointerEvent ? 'pointerup' : 'click', handleReaderTap);
  $('#rbook')?.addEventListener('dblclick', e => e.preventDefault());
  $('#rbook')?.addEventListener('touchstart', e => { if (e.touches.length > 1 && e.cancelable) e.preventDefault(); }, { passive: false });
  $('#tocBtn')?.addEventListener('click', () => openPanel('toc'));
  $('#setBtn')?.addEventListener('click', () => openPanel('settings'));
  $('#bottomTocBtn')?.addEventListener('click', () => openPanel('toc'));
  $('#bottomSetBtn')?.addEventListener('click', () => openPanel('settings'));
  $('#sleepBtn')?.addEventListener('click', () => sleepMinutesLeft() ? setSleepTimer(0) : openPanel('settings'));
  $('#rfPlay')?.addEventListener('click', () => tts.state === 'playing' ? tts.pause() : tts.play());
  $('#rfStop')?.addEventListener('click', () => tts.stop());
  $('#fontMinus')?.addEventListener('click', () => { state.fontSize = Math.max(16, state.fontSize - 2); persistCurrentReadingLayout(); repaginateKeepPosition(); });
  $('#fontPlus')?.addEventListener('click', () => { state.fontSize = Math.min(34, state.fontSize + 2); persistCurrentReadingLayout(); repaginateKeepPosition(); });
  $('#rfProg')?.addEventListener('click', e => { const r = e.currentTarget.getBoundingClientRect(); state.currentPage = Math.round(((e.clientX - r.left) / r.width) * (state.pages.length - 1)); renderPage(); });
}

async function render() {
  document.documentElement.dataset.theme = state.theme;
  $('#app').innerHTML = state.view === 'reader' ? readerTemplate() : libraryTemplate();
  bindEvents();
  if (state.view === 'reader') { renderPage(); renderPanel(); renderTtsState(); }
}
async function boot() {
  setTheme(state.theme);
  localStorage.removeItem('keepAwake');
  if ('speechSynthesis' in window) {
    speechSynthesis.getVoices();
    speechSynthesis.addEventListener?.('voiceschanged', () => {
      if (state.panel === 'settings') renderPanel();
    });
  }
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
document.addEventListener('visibilitychange', () => {
  // Backgrounding invalidates speech. Foregrounding deliberately does
  // nothing: the next utterance must come from an explicit Play action.
  if (document.visibilityState === 'hidden') tts.suspendForBackground();
});
boot().catch(err => { console.error(err); toast(`啟動失敗：${err.message}`); });
