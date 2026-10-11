import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { TtsPlaybackGeneration } from '../src/tts-playback-generation.js';
import { TtsBackgroundSession, silentWav } from '../src/tts-background-session.js';

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
function setup({ enabled = false, rejectPlay = false, throwPlay = false, media = true, unsupported = [], otherMedia = [] } = {}) {
  const events = [], spoken = [], audios = [], revoked = [], timers = new Map(), saved = new Map();
  const actions = new Map(), handlers = new Map();
  let timerId = 0;
  const document = { visibilityState: 'visible', querySelectorAll: () => otherMedia,
    addEventListener: (name, fn) => handlers.set(name, fn) };
  const mediaSession = { metadata: null, playbackState: 'none', setActionHandler(action, fn) {
    if (unsupported.includes(action)) throw new Error('unsupported');
    actions.set(action, fn);
  } };
  const env = { document, navigator: media ? { mediaSession } : {},
    MediaMetadata: class { constructor(values) { Object.assign(this, values); } },
    URL: { createObjectURL: () => `blob:fake-${audios.length}`, revokeObjectURL: url => revoked.push(url) },
    Audio: class {
      constructor(url) { this.src = url; this.paused = true; audios.push(this); }
      setAttribute() {}
      removeAttribute() { this.src = ''; }
      load() { events.push('load'); }
      play() {
        events.push('audio.play');
        if (throwPlay) throw new Error('blocked');
        this.paused = false;
        return rejectPlay ? Promise.reject(new Error('blocked')) : Promise.resolve();
      }
      pause() { events.push('audio.pause'); this.paused = true; this.onpause?.(); }
    },
  };
  const state = { backgroundTts: enabled, ttsVolume: 0.6, currentPage: 0, sleepUntil: 0, sleepTimer: null,
    pages: [{ startPara: 0 }], currentBook: { id: 'one', title: 'Test book', paragraphs: ['甲'.repeat(600), 'Chapter 2', 'English passage.'],
      chapters: [{ title: 'Chapter 1', idx: 0 }, { title: 'Chapter 2', idx: 1 }], progressPara: 0 } };
  const context = vm.createContext({ state, TtsPlaybackGeneration, console, document,
    TtsBackgroundSession: class extends TtsBackgroundSession { constructor(controller) { super(controller, env); } },
    window: { addEventListener: (name, fn) => handlers.set(name, fn) },
    localStorage: { getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v), removeItem: k => saved.delete(k) },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    speechSynthesis: { getVoices: () => [], speak: u => { events.push('speech.speak'); spoken.push(u); }, cancel: () => events.push('speech.cancel') },
    clampSpeechRate: () => 2.5, performance: { now: () => 1000 },
    clearTimeout: id => timers.delete(id), setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
    renderTtsState() {}, renderPanel() {}, highlightPara() {}, saveProgressFromPage() {}, toast() {},
    wakeLock: { request: async () => events.push('wake.request'), release: async () => events.push('wake.release') },
  });
  const queueSource = source.slice(source.indexOf('class SpeechQueue {'), source.indexOf('const tts = new SpeechQueue();'));
  const sleepSource = source.slice(source.indexOf('function checkSleepDeadline()'), source.indexOf('function sleepMinutesLeft()'));
  const listenerSource = source.slice(source.indexOf("document.addEventListener('visibilitychange'"), source.indexOf('boot().catch'));
  vm.runInContext(`${queueSource}\nconst tts = new SpeechQueue(); globalThis.queue = tts;\n${sleepSource}\n${listenerSource}`, context);
  const q = context.queue;
  q.isSupported = () => true;
  const hide = () => { document.visibilityState = 'hidden'; handlers.get('visibilitychange')(); };
  const show = () => { document.visibilityState = 'visible'; handlers.get('visibilitychange')(); handlers.get('pageshow')(); };
  return { q, events, spoken, audios, revoked, timers, saved, state, mediaSession, actions, handlers, hide, show, env };
}

test('WAV header and unsigned PCM payload are genuine one-second silence', async () => {
  const blob = silentWav(), buffer = await blob.arrayBuffer(), view = new DataView(buffer);
  assert.equal(blob.type, 'audio/wav');
  assert.equal(new TextDecoder().decode(buffer.slice(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(buffer.slice(8, 12)), 'WAVE');
  assert.equal(view.getUint32(24, true), 8000);
  assert.equal(view.getUint16(34, true), 8);
  assert.equal(view.getUint32(40, true), 8000);
  assert.equal(new Uint8Array(buffer, 44).every(v => v === 128), true);
});

test('default OFF has no audio or Media Session and hidden cancels once; show never resumes', () => {
  const h = setup(); h.q.play(); const staleEnd = h.spoken[0].onend;
  assert.equal(h.audios.length, 0); assert.equal(h.actions.size, 0);
  assert.equal(h.events.includes('speech.cancel'), false);
  h.hide(); assert.equal(h.q.state, 'paused');
  assert.equal(h.events.filter(e => e === 'speech.cancel').length, 1);
  h.show(); staleEnd(); assert.equal(h.spoken.length, 1);
});

test('ON calls companion play and first speak synchronously, no native cancel and one loop', () => {
  const h = setup({ enabled: true }); h.q.play();
  assert.deepEqual(h.events.slice(0, 2), ['audio.play', 'speech.speak']);
  assert.equal(h.events.includes('speech.cancel'), false);
  assert.equal(h.audios.length, 1); assert.equal(h.audios[0].loop, true); assert.equal(h.audios[0].volume, 0.6);
  h.q.play(); assert.equal(h.audios.length, 1);
  assert.equal(h.mediaSession.metadata.title, 'Test book');
  assert.equal(h.mediaSession.metadata.artist, 'Chapter 1');
  assert.equal(h.mediaSession.playbackState, 'playing');
});

test('ON hidden preserves generation and speech, releases wake lock, progresses across chapter; no foreground enqueue', () => {
  const h = setup({ enabled: true }); h.q.play();
  const generation = h.q.playback.value; h.hide();
  assert.equal(h.q.state, 'playing'); assert.equal(h.q.playback.value, generation);
  assert.equal(h.events.includes('speech.cancel'), false); assert.equal(h.events.includes('wake.release'), true);
  assert.equal(h.timers.size, 0);
  for (let i = 0; i < 3; i++) h.spoken[i].onend();
  assert.equal(h.spoken.length, 4); assert.equal(h.mediaSession.metadata.artist, 'Chapter 2');
  h.show(); assert.equal(h.spoken.length, 4); assert.equal(h.audios.length, 1);
});

test('pause releases audio/URL; stale callbacks and stale rejection cannot affect fresh Play', async () => {
  const h = setup({ enabled: true }); h.q.play();
  const staleEnd = h.spoken[0].onend, oldAudio = h.audios[0];
  h.actions.get('pause')(); assert.equal(h.q.state, 'paused');
  assert.equal(h.q.background.audio, null); assert.equal(h.revoked.length, 1);
  assert.equal(oldAudio.onpause, null); assert.equal(oldAudio.src, '');
  assert.equal(h.mediaSession.playbackState, 'paused');
  h.show(); assert.equal(h.spoken.length, 1);
  h.actions.get('play')(); const current = h.q.currentUtterance;
  staleEnd(); assert.equal(h.q.currentUtterance, current);
  assert.equal(h.audios.length, 2);
  h.actions.get('stop')(); assert.equal(h.mediaSession.metadata, null);
  assert.equal(h.mediaSession.playbackState, 'none');
  for (const action of ['play', 'pause', 'stop']) assert.equal(h.actions.get(action), null);
  assert.equal(h.revoked.length, 2);
});

test('audio play rejection pauses, retains segment and releases the loop without retry', async () => {
  const h = setup({ enabled: true, rejectPlay: true }); h.q.play();
  assert.equal(h.spoken.length, 1); // The promise was not awaited before speak.
  await Promise.resolve();
  assert.equal(h.q.state, 'paused'); assert.equal(h.revoked.length, 1);
  assert.equal(h.q.background.audio, null); assert.match(h.q.notice, /背景音訊/);
  h.show(); assert.equal(h.audios.length, 1); assert.equal(h.spoken.length, 1);
  assert.equal(h.q.resumeSegment, 0);
});

test('late rejection from stopped audio cannot pause a newer generation', async () => {
  const h = setup({ enabled: true, rejectPlay: true }); h.q.play(); h.q.pause();
  // Use a pending success for the fresh generation rather than another rejection.
  h.env.Audio.prototype.play = function () { return Promise.resolve(); };
  h.q.play(); const fresh = h.q.currentUtterance;
  await Promise.resolve();
  assert.equal(h.q.state, 'playing'); assert.equal(h.q.currentUtterance, fresh);
});

test('synchronous audio failure and speech error both clean up; no automatic retries', () => {
  const blocked = setup({ enabled: true, throwPlay: true }); blocked.q.play();
  assert.equal(blocked.q.state, 'paused'); assert.equal(blocked.spoken.length, 0); assert.equal(blocked.revoked.length, 1);
  const h = setup({ enabled: true }); h.q.play(); h.spoken[0].onerror({ error: 'interrupted' });
  assert.equal(h.q.state, 'paused'); assert.equal(h.q.background.audio, null); assert.equal(h.revoked.length, 1);
  h.show(); assert.equal(h.spoken.length, 1);
});

test('native audio interruption pauses via the same controller and never replays the loop', () => {
  const h = setup({ enabled: true }); h.q.play(); h.audios[0].onpause();
  assert.equal(h.q.state, 'paused'); assert.equal(h.q.background.audio, null);
  h.hide(); h.show(); assert.equal(h.audios.length, 1); assert.equal(h.spoken.length, 1);
});

test('sleep expiry gates hidden next segment and media Play, releasing audio', () => {
  const h = setup({ enabled: true }); h.q.play(); h.hide();
  h.state.sleepUntil = Date.now() - 1; h.spoken[0].onend();
  assert.equal(h.q.state, 'paused'); assert.equal(h.spoken.length, 1); assert.equal(h.revoked.length, 1);
  h.show(); assert.equal(h.spoken.length, 1);
  h.state.sleepUntil = Date.now() - 1; h.actions.get('play')();
  assert.equal(h.spoken.length, 1); assert.equal(h.audios.length, 1);
});

test('bfcache keeps experimental checkpoint without cancel; navigation releases and retains checkpoint', () => {
  const h = setup({ enabled: true }); h.q.play();
  h.handlers.get('pagehide')({ persisted: true }); assert.equal(h.q.state, 'playing');
  h.handlers.get('pagehide')({ persisted: false }); assert.equal(h.q.state, 'idle');
  assert.equal(h.q.background.audio, null); assert.equal(h.revoked.length, 1);
  assert.equal(h.mediaSession.metadata, null); assert.ok(h.saved.has('tts-position:one'));
  h.show(); assert.equal(h.spoken.length, 1);
  const off = setup(); off.q.play(); off.handlers.get('pagehide')({ persisted: true }); assert.equal(off.q.state, 'paused');
});

test('unsupported media actions and absent Media Session are graceful', () => {
  const h = setup({ enabled: true, unsupported: ['stop'] }); h.q.play();
  assert.equal(h.q.state, 'playing'); assert.equal(h.actions.has('stop'), false);
  h.q.stop(); assert.equal(h.mediaSession.metadata, null);
  const noMedia = setup({ enabled: true, media: false }); noMedia.q.play();
  assert.equal(noMedia.q.state, 'playing'); noMedia.q.stop(); assert.equal(noMedia.revoked.length, 1);
});

test('another real media owner prevents companion start; stopping never overwrites a replacement owner', () => {
  const h = setup({ enabled: true }); const realMetadata = { title: 'Real audiobook' };
  h.mediaSession.metadata = realMetadata; h.mediaSession.playbackState = 'playing'; h.q.play();
  assert.equal(h.audios.length, 0); assert.equal(h.spoken.length, 0);
  assert.equal(h.mediaSession.metadata, realMetadata); assert.equal(h.actions.size, 0);
  const active = setup({ enabled: true, otherMedia: [{ paused: false, ended: false }] }); active.q.play();
  assert.equal(active.audios.length, 0);
  const takeover = setup({ enabled: true }); takeover.q.play();
  takeover.mediaSession.metadata = realMetadata; takeover.mediaSession.playbackState = 'playing';
  const realPlay = () => {}; takeover.actions.set('play', realPlay); takeover.q.stop();
  assert.equal(takeover.mediaSession.metadata, realMetadata); assert.equal(takeover.actions.get('play'), realPlay);
});

test('book change, natural completion and startup watchdog release companion and session', () => {
  for (const finish of ['book', 'end', 'watchdog']) {
    const h = setup({ enabled: true }); h.q.play();
    if (finish === 'book') { h.q.stop(true); h.state.currentBook.id = 'two'; }
    if (finish === 'end') { while (h.q.state === 'playing') h.spoken.at(-1).onend(); }
    if (finish === 'watchdog') [...h.timers.values()][0]();
    assert.equal(h.q.background.audio, null); assert.equal(h.revoked.length, 1); assert.equal(h.mediaSession.metadata, null);
  }
});

test('diagnostic playback never activates background experiment and suspends when hidden', () => {
  const h = setup({ enabled: true }); h.q.play(); h.q.pause(); h.q.testRate();
  assert.equal(h.q.sessionBackground, false); assert.equal(h.q.background.audio, null);
  h.hide(); assert.equal(h.q.state, 'paused'); h.show(); assert.equal(h.spoken.length, 2);
});

test('persisted switch is strict opt-in and version/cache markers stay consistent', () => {
  assert.match(source, /backgroundTts: localStorage\.getItem\('backgroundTts'\) === 'true'/);
  assert.match(source, /localStorage\.setItem\('backgroundTts', String\(enabled\)\)/);
  assert.match(source, /背景聽書（實驗）/);
  assert.match(source, /無法保證背景播放/);
  const version = source.match(/const APP_VERSION = '([^']+)'/)[1];
  assert.ok(readFileSync(new URL('../index.html', import.meta.url), 'utf8').includes(`?v=${version}`));
  assert.ok(readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8').includes(`?v=${version}`));
});

test('switch handler persists both values, pauses once and renders stored opt-in on reload', () => {
  const storage = new Map();
  const binder = source.slice(source.indexOf('function bindPanelEvents()'), source.indexOf('function bindEvents()'));
  function panel() {
    const calls = [], listeners = new Map(); let html = '', inserted = false;
    const state = { backgroundTts: storage.get('backgroundTts') === 'true', currentBook: null };
    const checkbox = { addEventListener: (event, fn) => listeners.set(event, fn) };
    const voiceGroup = { insertAdjacentElement: (_, group) => { html = group.innerHTML; inserted = true; } };
    const voice = { closest: () => voiceGroup, addEventListener() {} };
    const context = vm.createContext({ state,
      $: selector => selector === '#speechVoice' ? voice : selector === '#speechEnglishVoice' ? { addEventListener() {} }
        : selector === '#backgroundTts' && inserted ? checkbox : null,
      $$: () => [], closePanel() {}, renderTtsState() {},
      tts: { sessionBackground: true, pause: () => calls.push('pause'), background: { clear: () => calls.push('clear') } },
      document: { createElement: () => ({}) },
      localStorage: { setItem: (k, v) => storage.set(k, v) },
    });
    vm.runInContext(`${binder}\nbindPanelEvents();`, context);
    return { html, state, calls, change: value => listeners.get('change')({ target: { checked: value } }) };
  }
  const first = panel(); assert.doesNotMatch(first.html, /type="checkbox" checked/);
  first.change(true); assert.equal(storage.get('backgroundTts'), 'true'); assert.equal(first.state.backgroundTts, true);
  assert.deepEqual(first.calls, ['pause', 'clear']);
  const reload = panel(); assert.match(reload.html, /type="checkbox" checked/);
  reload.change(false); assert.equal(storage.get('backgroundTts'), 'false');
  assert.doesNotMatch(panel().html, /type="checkbox" checked/);
});

test('cleanup still revokes Blob URL when media load throws', () => {
  const h = setup({ enabled: true }); h.q.play();
  h.audios[0].load = () => { throw new Error('unavailable'); };
  h.q.stop(); assert.equal(h.revoked.length, 1); assert.equal(h.q.background.audio, null);
});

test('wake lock acquired after hide/pause is immediately released', async () => {
  let finish, releases = 0;
  const sentinel = { released: false, release: async () => { releases++; }, addEventListener() {} };
  const document = { visibilityState: 'visible' };
  const context = vm.createContext({ document, state: {}, console, renderTtsState() {}, renderPanel() {},
    navigator: { wakeLock: { request: () => new Promise(resolve => { finish = resolve; }) } } });
  vm.runInContext(source.slice(source.indexOf('class WakeLockManager {'), source.indexOf('const wakeLock = new WakeLockManager();')) + '\nglobalThis.lock = new WakeLockManager();', context);
  const pending = context.lock.request(); document.visibilityState = 'hidden'; await context.lock.release();
  finish(sentinel); await pending; assert.equal(releases, 1); assert.equal(context.lock.sentinel, null);
});
