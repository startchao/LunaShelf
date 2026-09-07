import './style.css';
import { BookAudioPlayer, audioTime } from './book-audio-player.js';
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

const APP_VERSION = '0.7.0-background-audio';
const TTS_RATE_MIN = 0.5;
const TTS_RATE_MAX = 4;
const TTS_RATE_PRESET_VERSION = 'v0.4.12';
if (localStorage.getItem('ttsRatePresetVersion') !== TTS_RATE_PRESET_VERSION) {
  if (!localStorage.getItem('speechRate')) localStorage.setItem('speechRate', '2.5');
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
const DB_VERSION = 2;
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
  audioMode: false,
  audioImporting: false,
};

class DB {
  static open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('fonts')) db.createObjectStore('fonts', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      };
      req.onblocked = () => toast('請關閉其他 LunaShelf 分頁，再重新開啟以完成更新');
      req.onsuccess = () => { req.result.onversionchange = () => req.result.close(); resolve(req.result); };
      req.onerror = () => reject(req.error);
    });
  }
  static async tx(store, mode, fn) {
    const db = await DB.open();
    return new Promise((resolve, reject) => {
      const tr = db.transaction(store, mode);
      const st = tr.objectStore(store);
      const result = fn(st);
      tr.oncomplete = () => { db.close(); resolve(result?.result ?? result); };
      tr.onerror = () => { db.close(); reject(tr.error); };
      tr.onabort = () => { db.close(); reject(tr.error || new Error('儲存未完成')); };
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
    this.notice = "";
    this.resumeSegment = 0;
    this.diagnostic = false;
    this.diagnosticResults = [];
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
      u.startedAt = performance.now();
      this.notice = '';
      renderTtsState();
      if (!this.diagnostic) highlightPara(paraIdx);
    };
    u.onend = () => {
      if (!this.playback.clear(u, generation) || this.state !== 'playing') return;
      clearTimeout(this.startWatchdog);
      this.currentUtterance = null;
      if (this.diagnostic) {
        const elapsed = u.startedAt == null ? null : ((performance.now() - u.startedAt) / 1000).toFixed(2);
        this.diagnosticResults.unshift(`${u.voice?.name || '系統自動'} · 語速 ${Number(u.rate).toFixed(1)}：${elapsed == null ? '未收到開始事件，無法計時' : elapsed + ' 秒'}`);
        this.diagnosticResults = this.diagnosticResults.slice(0, 6);
        this.diagnostic = false;
        this.state = 'paused';
        this.notice = '試聽完成，可繼續聽書';
        renderPanel();
        renderTtsState();
        return;
      }
      this.activeSegment = null;
      const next = this.segments[this.segmentIndex];
      if (next) this.checkpoint(next);
      saveProgressFromPage();
      this.speakNext(generation);
    };
    u.onerror = ev => {
      if (!this.playback.isCurrent(u, generation) || this.state !== 'playing') return;
      console.warn('TTS error', ev.error || ev);
      this.pause(); // Keep the failed segment; never silently skip text.
      this.notice = '朗讀中斷，請點播放從本段繼續';
      renderTtsState();
    };
    return u;
  }
  buildSegments(startPara) {
    const book = state.currentBook;
    const out = [];
    for (let i = startPara; book && i < book.paragraphs.length; i++) {
      this.splitText(book.paragraphs[i] || '').forEach((text, part) => { if (text) out.push({ text, paraIdx: i, part }); });
    }
    return out;
  }
  prepareFrom(startPara) {
    this.nextPara = Math.max(0, startPara || 0);
    this.segments = this.buildSegments(this.nextPara);
    const found = this.segments.findIndex(seg => seg.paraIdx === this.nextPara && seg.part === this.resumeSegment);
    this.segmentIndex = Math.max(0, found);
    this.activeSegment = null;
  }
  checkpoint(seg) {
    this.resumePara = seg.paraIdx;
    this.resumeSegment = seg.part || 0;
    try { localStorage.setItem(`tts-position:${state.currentBook.id}`, JSON.stringify({ paraIdx: this.resumePara, part: this.resumeSegment })); } catch (_) { /* retain in memory */ }
  }
  restorePosition() {
    this.resumePara = null;
    this.resumeSegment = 0;
    try {
      const saved = JSON.parse(localStorage.getItem(`tts-position:${state.currentBook.id}`));
      if (saved && Number.isInteger(saved.paraIdx) && saved.paraIdx >= 0 && saved.paraIdx < state.currentBook.paragraphs.length) {
        this.resumePara = saved.paraIdx;
        this.resumeSegment = Number.isInteger(saved.part) && saved.part >= 0 ? saved.part : 0;
      }
    } catch (_) { /* invalid or unavailable storage */ }
  }
  testRate() {
    bookAudio.pause();
    bookAudio.releaseSession();
    state.audioMode = false;
    if (!this.isSupported()) return toast('此瀏覽器不支援朗讀');
    if (this.state === 'playing') {
      this.pause();
      return toast('已暫停，請再點一次測試語速');
    }
    const generation = this.invalidateSpeechState();
    this.sessionVoice = this.pickVoice();
    this.diagnostic = true;
    this.state = 'playing';
    this.notice = '正在測試語速；可按暫停中止';
    const u = this.makeUtterance('清晨的陽光穿過窗簾，灑在桌上的小說。我們沿著故事前進，聆聽每一句話，感受角色的心情。', 0, generation);
    this.currentUtterance = u;
    this.playback.set(u, generation);
    renderTtsState();
    speechSynthesis.speak(u);
    this.armStartWatchdog(u, generation);
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
    bookAudio.pause();
    bookAudio.releaseSession();
    if (!this.isSupported()) return toast('這個瀏覽器不支援朗讀，請用 Safari/Edge/Chrome 測試');
    if (this.state === 'playing') return;
    if (checkSleepDeadline()) return;
    this.diagnostic = false;
    this.notice = '';
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

    wakeLock.request().catch(err => console.warn('wake lock request failed', err));
  }
  armStartWatchdog(utterance, generation) {
    clearTimeout(this.startWatchdog);
    this.startWatchdog = setTimeout(() => {
      if (!this.playback.isCurrent(utterance, generation) || this.state !== 'playing') return;
      if (utterance.startedAt != null) return;
      if (this.activeSegment && !this.diagnostic) this.checkpoint(this.activeSegment);
      this.state = 'idle';
      this.cancelSpeechEngine();
      this.diagnostic = false;
      this.notice = '朗讀未啟動，請點播放重試；若仍無聲，請重新開啟閱讀器';
      this.activeSegment = null;
  
      wakeLock.release().catch(() => {});
      renderTtsState();
      toast('朗讀未啟動，請再點一次播放');
    }, 5000);
  }
  speakNext(generation) {
    const book = state.currentBook;
    if (checkSleepDeadline() || this.state !== 'playing' || generation !== this.playback.value || !book) return;
    const seg = this.segments[this.segmentIndex++];
    if (!seg) return this.stop();
    this.nextPara = seg.paraIdx;
    this.resumePara = seg.paraIdx;
    this.activeSegment = seg;
    this.checkpoint(seg);
    const utterance = this.makeUtterance(seg.text, seg.paraIdx, generation);
    this.currentUtterance = utterance;
    if (!this.playback.set(utterance, generation)) return;
    speechSynthesis.speak(utterance);
    this.armStartWatchdog(utterance, generation);
  }
  suspendForBackground() {
    if (this.state !== 'playing') return;
    if (this.activeSegment && !this.diagnostic) this.checkpoint(this.activeSegment);
    this.state = 'paused';
    this.diagnostic = false;
    this.notice = '已保留聽書位置，回來後請點播放繼續';
    this.cancelSpeechEngine();
    this.activeSegment = null;

    wakeLock.release().catch(() => {});
    renderTtsState();
    saveProgressFromPage();
  }
  pause() {
    if (this.activeSegment && !this.diagnostic) this.checkpoint(this.activeSegment);
    this.state = 'paused';
    this.diagnostic = false;
    this.notice = '已暫停，點播放繼續';
    this.cancelSpeechEngine();
    this.activeSegment = null;

    wakeLock.release().catch(() => {});
    renderTtsState();
    saveProgressFromPage();
  }
  stop(preservePosition = false) {
    this.diagnostic = false;
    this.notice = "";
    if (!preservePosition && state.currentBook) {
      try { localStorage.removeItem(`tts-position:${state.currentBook.id}`); } catch (_) {}
    }
    this.resumeSegment = 0;
    this.state = 'idle';
    this.cancelSpeechEngine();
    this.resumePara = null;
    this.activeSegment = null;
    this.segments = [];

    wakeLock.release().catch(() => {});
    renderTtsState();
    saveProgressFromPage();
  }
}

const tts = new SpeechQueue();
const audioElement = document.createElement('audio');
audioElement.setAttribute('playsinline', '');
audioElement.setAttribute('aria-hidden', 'true');
// Never put the media element inside #app, which is replaced while reading.
document.body.appendChild(audioElement);
const bookAudio = new BookAudioPlayer({
  audio: audioElement, storage: localStorage, urls: URL,
  platform: { mediaSession: navigator.mediaSession, audioSession: navigator.audioSession, MediaMetadata: window.MediaMetadata },
  changed: () => { renderTtsState(); renderAudioProgress(); },
  deadline: () => checkSleepDeadline(),
  beforePlay: () => { tts.pause(); state.audioMode = true; },
});
let bookOpenGeneration = 0;
function playbackIsPlaying() { return state.audioMode ? bookAudio.isPlaying : tts.state === 'playing'; }
function togglePlayback() {
  if (!state.audioMode) return tts.state === 'playing' ? tts.pause() : tts.play();
  if (bookAudio.isPlaying) return bookAudio.pause();
  tts.pause();
  return bookAudio.play();
}
function pausePlayback() { tts.pause(); bookAudio.pause(); }
function renderAudioProgress() {
  const label = $('#audioPosition');
  const slider = $('#audioSeek');
  if (label) label.textContent = `${audioTime(audioElement.currentTime)} / ${audioTime(audioElement.duration)}`;
  if (slider && document.activeElement !== slider) {
    slider.max = String(Number.isFinite(audioElement.duration) ? audioElement.duration : 0);
    slider.value = String(audioElement.currentTime || 0);
    slider.disabled = !Number.isFinite(audioElement.duration) || audioElement.duration <= 0;
  }
  const button = $('#audioPlay');
  if (button) button.textContent = bookAudio.isPlaying ? '暫停' : '播放音訊';
}
async function importBookAudio(file) {
  if (!file || !state.currentBook || state.audioImporting) return;
  const book = state.currentBook;
  const generation = bookOpenGeneration;
  if (!/\.(m4a|m4b|mp3|wav|aac|mp4|aiff?|caf)$/i.test(file.name) && !file.type.startsWith('audio/')) return toast('請選擇音訊檔，例如 M4A 或 MP3');
  state.audioImporting = true;
  renderPanel();
  toast('正在將音訊儲存到手機…');
  try {
    const record = { id: book.id, name: file.name, blob: file, size: file.size };
    await DB.put('audio', record);
    if (generation !== bookOpenGeneration || state.currentBook?.id !== book.id) return;
    tts.pause();
    bookAudio.detach();
    try { localStorage.removeItem(`book-audio:position:${book.id}`); } catch (_) {}
    bookAudio.attach(book, record);
    state.audioMode = true;
    toast('音訊已匯入，點播放後即可測試鎖屏聽書');
  } catch (err) {
    console.warn('audio import failed', err);
    toast('音訊儲存失敗，請確認空間足夠，或改用較小的音訊檔');
  } finally {
    state.audioImporting = false;
    renderPanel();
    renderTtsState();
  }
}
function audioPanelTemplate() {
  const available = bookAudio.bookId === state.currentBook?.id;
  return `<div class="sg audio-settings"><div class="sg-lbl">鎖屏聽書 · 音訊模式</div>
    <p class="sg-hint">匯入已轉好的小說音訊，播放後可鎖屏或切換 App。音訊位置獨立記憶，文字不會自動跟讀。</p>
    <label class="font-import-btn">${state.audioImporting ? '正在儲存…' : available ? '更換本書音訊' : '匯入本書音訊'}<input id="bookAudioInput" type="file" accept="audio/*,.m4a,.m4b,.mp3,.wav,.aac,.mp4,.aiff,.caf" ${state.audioImporting ? 'disabled' : ''} hidden></label>
    ${available ? `<p class="sg-hint">${esc(bookAudio.name)}</p><div class="font-opts"><button class="font-opt ${state.audioMode ? 'on' : ''}" id="useAudio">音訊模式</button><button class="font-opt ${!state.audioMode ? 'on' : ''}" id="useSpeech">即時朗讀</button></div>
    <div class="audio-buttons"><button class="font-opt" id="audioBack">倒退 15 秒</button><button class="font-opt" id="audioPlay">${bookAudio.isPlaying ? '暫停' : '播放音訊'}</button><button class="font-opt" id="audioForward">前進 15 秒</button></div>
    <div class="sg-hint" id="audioPosition">${audioTime(audioElement.currentTime)} / ${audioTime(audioElement.duration)}</div><input id="audioSeek" class="audio-seek" type="range" aria-label="音訊播放位置" min="0" max="${Number.isFinite(audioElement.duration) ? audioElement.duration : 0}" value="${audioElement.currentTime || 0}" step="1">
    <label class="spd-wrap"><span class="sg-hint">音訊倍速</span><input class="spd-slider" id="audioRate" type="range" min="0.5" max="4" step="0.1" value="${bookAudio.rate}"><span id="audioRateValue" class="spd-val">${bookAudio.rate.toFixed(1)}×</span></label>
    <p class="sg-hint">音訊倍速與下方即時朗讀的語速分開設定。iOS 背景定時停止可能延後。</p><button class="font-opt" id="removeAudio" ${state.audioImporting ? 'disabled' : ''}>移除本書音訊</button>` : ''}
    <details class="audio-guide"><summary>只用 iPhone，如何把小說轉成音訊？</summary>
    <p>第一次：打開「捷徑」新增捷徑，命名為「LunaShelf轉音訊」，依序加入三個動作：</p><ol><li>取得剪貼簿</li><li>用文字製作語音音訊（Make Spoken Audio from Text），輸入選上一個動作的剪貼簿，選擇中文聲音</li><li>儲存檔案，輸入選語音音訊，開啟「詢問儲存位置」</li></ol>
    <p>之後在這裡複製文字，執行捷徑，將音訊存到「檔案」，再回來匯入。先以本章測試；全書轉檔可能耗時或失敗。可用已下載的系統聲音，不需 Mac 或第三方語音帳號。</p>
    <label>轉檔範圍 <select id="audioTextScope" class="font-opt"><option value="chapter">目前章節</option><option value="book">整本書</option></select></label><div class="audio-buttons"><button class="font-opt" id="copyAudioText">① 複製文字</button><a class="font-opt" href="shortcuts://run-shortcut?name=${encodeURIComponent('LunaShelf轉音訊')}">② 開啟轉檔捷徑</a></div><p class="sg-hint">找不到捷徑時，請先依上方建立。無法從 PWA 開啟時，可手動切到「捷徑」執行。</p>
    </details></div>`;
}
async function copyAudioText() {
  const book = state.currentBook;
  if (!book) return;
  const chapter = getChapterIndex(state.pages[state.currentPage]?.startPara || 0);
  const scope = $('#audioTextScope')?.value;
  const start = scope === 'book' ? 0 : (book.chapters[chapter]?.idx || 0);
  const end = scope === 'book' ? book.paragraphs.length : (book.chapters[chapter + 1]?.idx ?? book.paragraphs.length);
  const text = book.paragraphs.slice(start, end).join('\n');
  try { await navigator.clipboard.writeText(text); toast(`已複製 ${text.length.toLocaleString()} 字，請開啟轉檔捷徑`); }
  catch (_) { toast('無法複製，請從原始 TXT 選取文字，複製後執行捷徑'); }
}


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
  saveBook(state.currentBook).catch(err => console.warn('progress save failed', err));
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
  tts.stop();
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
  const status = $('#ttsStatus');
  if (status) status.textContent = state.audioMode ? (bookAudio.notice || (bookAudio.isPlaying ? '音訊播放中 · 可鎖屏聽書' : '音訊已暫停')) : (tts.notice || (tts.state === 'playing' ? '朗讀中' : ''));
  const btn = $('#rfPlay');
  if (btn) btn.textContent = playbackIsPlaying() ? '⏸' : '▶';
  const sleepBtn = $('#sleepBtn');
  if (sleepBtn) {
    const left = sleepMinutesLeft();
    sleepBtn.textContent = left ? `${left}` : '⏱';
    sleepBtn.classList.toggle('on', Boolean(left));
    sleepBtn.title = left ? `定時關閉：剩 ${left} 分；點擊取消` : '選擇定時關閉時間';
  }
}
function checkSleepDeadline() {
  if (!state.sleepUntil || Date.now() < state.sleepUntil) return false;
  clearTimeout(state.sleepTimer);
  state.sleepUntil = 0;
  localStorage.removeItem('sleepUntil');
  pausePlayback();
  tts.notice = '定時結束，已暫停朗讀';
  bookAudio.notice = '定時結束，已暫停音訊';
  renderPanel();
  renderTtsState();
  return true;
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
    state.sleepTimer = setTimeout(() => { pausePlayback(); state.sleepUntil = 0; localStorage.removeItem('sleepUntil'); toast('定時結束，已停止朗讀'); renderPanel(); renderTtsState(); }, minutes * 60000);
    toast(`已設定 ${minutes} 分鐘後停止`);
  }
  renderPanel();
  renderTtsState();
}
function restoreSleepTimer() {
  const left = state.sleepUntil - Date.now();
  if (left > 0) state.sleepTimer = setTimeout(() => { pausePlayback(); state.sleepUntil = 0; localStorage.removeItem('sleepUntil'); toast('定時結束，已停止朗讀'); renderPanel(); renderTtsState(); }, left);
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
      <main class="rbook" id="rbook"><div class="tap-zone zone-left" id="zoneLeft"></div><div class="tap-zone zone-mid" id="zoneMid"></div><div class="tap-zone zone-right" id="zoneRight"></div><article class="rpage ${tableLayout.className}" data-table-layout="${tableLayout.mode}"><div class="rp-body"></div><footer class="rp-foot"><span id="ttsStatus" class="tts-status" role="status" aria-live="polite"></span><span class="rp-num">…</span></footer></article></main>
      <footer class="reader-controls ${state.toolbarOn ? 'show' : ''}"><button class="rfbt" id="rfPlay" aria-label="播放/暫停">▶</button><button class="rfbt" id="rfStop" aria-label="停止">⏹</button><button class="rfbt" id="sleepBtn" aria-label="定時關閉">⏱</button><div class="rf-div"></div><button class="rfbt" id="bottomTocBtn" aria-label="目錄">☰</button><button class="rfbt" id="bottomSetBtn" aria-label="設定">⚙</button><button class="rftog" id="themeBtn" aria-label="日夜切換">${state.theme === 'dark' ? '☀' : '🌙'}</button><div class="rf-div"></div><button class="rffont" id="fontMinus">A−</button><button class="rffont" id="fontPlus">A+</button><div class="rf-prog-wrap"><div class="rf-prog" id="rfProg"><div class="rf-prog-f"></div></div><span class="rf-pct">0%</span></div></footer>
      <div id="panelRoot"></div>
    </section>`;
}
function ttsVoiceOptions() {
  const selected = localStorage.getItem('speechVoiceURI') || '';
  const voices = 'speechSynthesis' in window ? speechSynthesis.getVoices() : [];
  const chineseVoices = voices.filter(v => /zh|cmn|han/i.test(`${v.lang} ${v.name}`));
  const options = chineseVoices.map(v => `<option value="${esc(v.voiceURI)}" ${selected === v.voiceURI ? 'selected' : ''}>${esc(v.name)}（${esc(v.lang)}）</option>`).join('');
  return `<option value="" ${selected === '' ? 'selected' : ''}>中文優先（自動選擇）</option><option value="__auto__" ${selected === '__auto__' ? 'selected' : ''}>系統自動聲線</option>${options}`;
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
  return `<div class="pback on"><div class="pov" id="panelClose"></div><div class="pbox"><div class="phd"><span class="phd-t">⚙ 閱讀設定</span><button class="pcls" id="panelX">×</button></div><div class="pbody">${audioPanelTemplate()}<div class="sg"><div class="sg-lbl">閱讀版面（各自記憶調整）</div><div class="font-opts preset-opts"><button class="font-opt ${state.readingPresetMode === 'novel' ? 'on' : ''}" data-reading-preset="novel">小說閱讀</button><button class="font-opt ${state.readingPresetMode === 'english' ? 'on' : ''}" data-reading-preset="english">英文舒讀</button></div><div class="sg-hint">目前版面的字體、字級、行高、段距、邊距與表格模式會分開保存。</div></div><div class="sg"><div class="sg-lbl">定時關閉 ${sleepLeft ? `· 剩 ${sleepLeft} 分` : ''}</div><div class="slp-wrap">${sleepBtns}</div></div><div class="sg"><div class="sg-lbl">字體</div><div class="font-opts font-builtins"><button class="font-opt ${state.fontFamily === 'serif' ? 'on' : ''}" data-font="serif">中文宋體</button><button class="font-opt ${state.fontFamily === 'english-serif' ? 'on' : ''}" data-font="english-serif">英文襯線</button><button class="font-opt ${state.fontFamily === 'system' ? 'on' : ''}" data-font="system">系統黑體</button></div><div class="font-list">${importedFonts || '<div class="sg-hint">尚未匯入自訂字體</div>'}</div><label class="font-import-btn">＋ 匯入字體<input id="panelFontInput" type="file" accept=".ttf,.otf,.woff,.woff2,font/*" hidden></label></div><div class="sg"><div class="sg-lbl">表格版面</div><div class="font-opts table-layout-opts"><button class="font-opt ${state.tableLayoutMode === 'standard' ? 'on' : ''}" data-table-layout-mode="standard" aria-pressed="${state.tableLayoutMode === 'standard'}">標準表格</button><button class="font-opt ${state.tableLayoutMode === 'bilingual' ? 'on' : ''}" data-table-layout-mode="bilingual" aria-pressed="${state.tableLayoutMode === 'bilingual'}">雙語表格</button></div><div class="sg-hint">雙語表格會將兩欄內容在手機顯示為上下對照卡片，寬螢幕則並排顯示；不影響一般文章段落。</div></div><div class="sg"><div class="sg-lbl">閱讀排版</div><div class="spd-wrap"><span class="sg-hint">字級</span><input type="range" class="spd-slider" id="fontSize" min="16" max="34" step="1" value="${state.fontSize}"><span class="spd-val" id="fontSizeVal">${state.fontSize}px</span></div><div class="spd-wrap"><span class="sg-hint">行高</span><input type="range" class="spd-slider" id="lineHeight" min="1.0" max="2.5" step="0.1" value="${lineHeight}"><span class="spd-val" id="lineHeightVal">${lineHeight}×</span></div><div class="spd-wrap"><span class="sg-hint">段距</span><input type="range" class="spd-slider" id="paragraphSpacing" min="0" max="2" step="0.1" value="${paragraphSpacing}"><span class="spd-val" id="paragraphSpacingVal">${paragraphSpacing}行</span></div><div class="sg-hint">段距以「行」為單位；0.5 行就是 tReader 預設。</div><div class="sg-lbl layout-sub-label">左右邊距</div><div class="font-opts margin-opts"><button class="font-opt ${state.marginPreset === 'narrow' ? 'on' : ''}" data-margin-preset="narrow">窄</button><button class="font-opt ${state.marginPreset === 'standard' ? 'on' : ''}" data-margin-preset="standard">標準</button><button class="font-opt ${state.marginPreset === 'wide' ? 'on' : ''}" data-margin-preset="wide">寬</button></div></div><div class="sg"><div class="sg-lbl">聽書語速</div><div class="spd-wrap"><input type="range" class="spd-slider" id="speechRate" min="${TTS_RATE_MIN}" max="${TTS_RATE_MAX}" step="0.1" value="${speechRate}"><span class="spd-val" id="speechRateVal">${speechRate.toFixed(1)}</span></div><div class="sg-hint">語速參數可調至 4，實際速度受 iOS 與聲線限制，並非精確倍速。換聲線或語速後，可測試同一句話的秒數；若提高參數後秒數相同，表示目前聲線已達速度上限。</div><button class="font-opt" id="testSpeechRate">測試目前語速</button><div class="sg-hint" role="status">${tts.diagnosticResults.map(esc).join("<br>")}</div><div class="sg-hint">iPhone 網頁朗讀在鎖屏或切換 App 後會暫停；回來點播放即可從保留的分段繼續。</div></div><div class="sg"><div class="sg-lbl">朗讀聲線</div><select class="font-opt" id="speechVoice">${ttsVoiceOptions()}</select><div class="sg-hint">自動優先選擇繁體中文聲線；變更後於下次按播放時生效。</div></div><div class="sg"><div class="sg-lbl">AirPods／藍牙聽書音量</div><div class="spd-wrap"><input type="range" class="spd-slider" id="speechVolume" min="0.1" max="1" step="0.05" value="${speechVolume}"><span class="spd-val" id="speechVolumeVal">${Math.round(speechVolume * 100)}%</span></div><div class="sg-hint">若 AirPods 觸控音量無法控制網頁朗讀，請用這裡調整。此設定會套用到下一段朗讀，並盡量即時調整目前段落。</div></div></div></div></div>`;
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
  const generation = ++bookOpenGeneration;
  tts.stop(true);
  bookAudio.detach();
  state.audioMode = false;
  const [book, audio] = await Promise.all([DB.get('books', id), DB.get('audio', id)]);
  if (generation !== bookOpenGeneration || !book) return;
  state.currentBook = TxtParser.enrichBook(book);
  bookAudio.attach(state.currentBook, audio);
  state.audioMode = Boolean(audio);
  tts.restorePosition();
  state.currentBook.lastReadAt = Date.now();
  await saveBook(state.currentBook);
  state.view = 'reader';
  state.toolbarOn = false;
  paginate(state.currentBook.progressPara || 0);
  await render();
}
function bindPanelEvents() {
  $('#bookAudioInput')?.addEventListener('change', e => importBookAudio(e.target.files[0]));
  $('#copyAudioText')?.addEventListener('click', copyAudioText);
  $('#useAudio')?.addEventListener('click', () => { tts.pause(); state.audioMode = true; renderPanel(); renderTtsState(); });
  $('#useSpeech')?.addEventListener('click', () => { bookAudio.pause(); bookAudio.releaseSession(); state.audioMode = false; renderPanel(); renderTtsState(); });
  $('#audioPlay')?.addEventListener('click', () => { state.audioMode = true; togglePlayback(); });
  $('#audioBack')?.addEventListener('click', () => bookAudio.skip(-15));
  $('#audioForward')?.addEventListener('click', () => bookAudio.skip(15));
  $('#audioSeek')?.addEventListener('change', e => bookAudio.seekTo(e.target.value));
  $('#audioRate')?.addEventListener('input', e => { bookAudio.setRate(e.target.value); $('#audioRateValue').textContent = `${bookAudio.rate.toFixed(1)}×`; });
  $('#removeAudio')?.addEventListener('click', async () => {
    const id = state.currentBook.id;
    if (state.audioImporting) return;
    try {
      await DB.delete('audio', id);
      if (state.currentBook?.id !== id) return;
      bookAudio.detach(); state.audioMode = false;
      try { localStorage.removeItem(`book-audio:position:${id}`); } catch (_) {}
      renderPanel(); renderTtsState(); toast('已移除音訊，小說文字仍保留');
    } catch (_) { toast('移除失敗，請重試'); }
  });
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
  $('#speechRate')?.addEventListener('input', e => { localStorage.setItem('speechRate', e.target.value); $('#speechRateVal') && ($('#speechRateVal').textContent = `${Number(e.target.value).toFixed(1)}`); });
  $('#speechVoice')?.addEventListener('change', e => {
    if (e.target.value) localStorage.setItem('speechVoiceURI', e.target.value);
    else localStorage.removeItem('speechVoiceURI');
  });
  $('#testSpeechRate')?.addEventListener('click', () => tts.testRate());
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
  $$('[data-delete]').forEach(btn => btn.addEventListener('click', async e => { e.stopPropagation(); await DB.delete('books', btn.dataset.delete); await DB.delete('audio', btn.dataset.delete); state.books = (await DB.all('books')).map(TxtParser.enrichBook); render(); }));
  $('#backBtn')?.addEventListener('click', async () => { ++bookOpenGeneration; tts.stop(true); bookAudio.detach(); state.audioMode = false; state.books = (await DB.all('books')).map(TxtParser.enrichBook); state.view = 'library'; render(); });
  $('#rbook')?.addEventListener(window.PointerEvent ? 'pointerup' : 'click', handleReaderTap);
  $('#rbook')?.addEventListener('dblclick', e => e.preventDefault());
  $('#rbook')?.addEventListener('touchstart', e => { if (e.touches.length > 1 && e.cancelable) e.preventDefault(); }, { passive: false });
  $('#tocBtn')?.addEventListener('click', () => openPanel('toc'));
  $('#setBtn')?.addEventListener('click', () => openPanel('settings'));
  $('#bottomTocBtn')?.addEventListener('click', () => openPanel('toc'));
  $('#bottomSetBtn')?.addEventListener('click', () => openPanel('settings'));
  $('#sleepBtn')?.addEventListener('click', () => sleepMinutesLeft() ? setSleepTimer(0) : openPanel('settings'));
  $('#rfPlay')?.addEventListener('click', togglePlayback);
  $('#rfStop')?.addEventListener('click', () => state.audioMode ? bookAudio.stop() : tts.stop());
  $('#fontMinus')?.addEventListener('click', () => { state.fontSize = Math.max(16, state.fontSize - 2); persistCurrentReadingLayout(); repaginateKeepPosition(); });
  $('#fontPlus')?.addEventListener('click', () => { state.fontSize = Math.min(34, state.fontSize + 2); persistCurrentReadingLayout(); repaginateKeepPosition(); });
  $('#rfProg')?.addEventListener('click', e => { const r = e.currentTarget.getBoundingClientRect(); tts.stop(); state.currentPage = Math.round(((e.clientX - r.left) / r.width) * (state.pages.length - 1)); renderPage(); });
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
  // Background speech requires an explicit Play to resume; foregrounding
  // only reconciles the sleep deadline and visible controls.
  if (document.visibilityState === 'hidden') tts.suspendForBackground();
  else { checkSleepDeadline(); renderTtsState(); }
  // Real audio remains active when hidden. Save only; never pause it here.
  bookAudio.save();
});
window.addEventListener('pagehide', () => { tts.suspendForBackground(); bookAudio.save(); });
window.addEventListener('pageshow', () => { checkSleepDeadline(); renderTtsState(); });
boot().catch(err => { console.error(err); toast(`啟動失敗：${err.message}`); });
