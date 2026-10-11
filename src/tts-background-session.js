// Optional companion keepalive: a looping silent track that keeps iOS treating
// the page as "playing" while in background. Best-effort only; it grants no
// guarantee of background execution.
//
// Fully decoupled from the TTS controller by design: interruption or failure
// of the keepalive must NEVER pause or cancel speech. A keepalive failure only
// releases the keepalive itself; foreground TTS continues without it.
export function silentWav() {
  const samples = 8000;
  const buffer = new ArrayBuffer(44 + samples);
  const view = new DataView(buffer);
  const text = (offset, value) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, 36 + samples, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, samples, true); view.setUint32(28, samples, true);
  view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  text(36, 'data'); view.setUint32(40, samples, true);
  new Uint8Array(buffer, 44).fill(128); // Unsigned 8-bit PCM silence.
  return new Blob([buffer], { type: 'audio/wav' });
}

export class TtsBackgroundSession {
  constructor(controller, env = globalThis) {
    this.controller = controller;
    this.env = env;
    this.audio = null;
    this.url = null;
    this.metadata = null;
    this.actions = new Set();
  }
  otherMediaActive() {
    return [...(this.env.document?.querySelectorAll('audio, video') || [])]
      .some(media => media !== this.audio && !media.paused && !media.ended);
  }
  ownsMedia() {
    return this.metadata !== null && this.env.navigator?.mediaSession?.metadata === this.metadata;
  }
  canStart() {
    const session = this.env.navigator?.mediaSession;
    return !this.otherMediaActive() && (!session || this.ownsMedia()
      || (session.metadata == null && (!session.playbackState || session.playbackState === 'none')));
  }
  start(volume) {
    if (this.audio) return true;
    if (!this.canStart()) return false;
    try {
      this.url = this.env.URL.createObjectURL(silentWav());
      const audio = new this.env.Audio(this.url);
      this.audio = audio;
      audio.loop = true;
      audio.volume = volume;
      audio.setAttribute('playsinline', '');
      // Any keepalive failure only releases the keepalive. It must never
      // pause or cancel speech: foreground TTS continues without it.
      const release = () => {
        if (this.audio !== audio) return; // A rejection from a previous Play is stale.
        this.stopAudio();
        // Notify only (never pause/cancel): the controller downgrades to
        // foreground-only TTS. PR #6's race was a failure callback that
        // paused the controller; this one must not.
        const lost = this.controller?.onKeepaliveLost;
        if (typeof lost === 'function') { try { lost.call(this.controller); } catch (_) {} }
      };
      audio.onerror = release;
      audio.onended = release;
      // System interruption (call, Siri, notification) only restarts the
      // sacrificial keepalive, best-effort. It never touches the TTS
      // controller: the keepalive's interruption has no side effects.
      audio.onpause = () => {
        if (this.audio !== audio) return; // stale
        const later = this.env.setTimeout;
        if (typeof later !== 'function') return;
        later(() => {
          if (this.audio !== audio) return;
          if (!this.controller || this.controller.state !== 'playing') return;
          try {
            const pending = audio.play();
            if (pending && typeof pending.catch === 'function') pending.catch(() => {});
          } catch (_) { /* best-effort; no user gesture while backgrounded */ }
        }, 1500);
      };
      // Must be called synchronously inside explicit Play: a handler that
      // awaits before play() has already lost the user-gesture context.
      const pending = audio.play();
      if (pending && typeof pending.catch === 'function') {
        pending.catch(release);
      }
      return true;
    } catch (_) {
      this.stopAudio();
      return false;
    }
  }
  update(book, paraIdx, playbackState) {
    const session = this.env.navigator?.mediaSession;
    if (!session || !book || this.otherMediaActive()) return;
    if (!this.ownsMedia() && (session.metadata != null || (session.playbackState && session.playbackState !== 'none'))) return;
    try {
      const chapter = [...(book.chapters || [])].reverse().find(ch => ch.idx <= paraIdx);
      const values = { title: book.title || '月閣', artist: chapter?.title || '全文', album: '月閣 · 背景聽書（實驗）' };
      const metadata = this.env.MediaMetadata ? new this.env.MediaMetadata(values) : values;
      session.metadata = metadata;
      this.metadata = metadata;
      session.playbackState = playbackState;
      for (const action of ['play', 'pause', 'stop']) {
        try {
          session.setActionHandler(action, () => {
            if (this.ownsMedia() && !this.otherMediaActive()) this.controller[action]();
          });
          this.actions.add(action);
        } catch (_) { /* Unsupported action on this browser. */ }
      }
    } catch (_) { /* Media Session is optional; Web Speech still works. */ }
  }
  stopAudio() {
    const audio = this.audio;
    this.audio = null; // Detach before pause(), including synchronous browser callbacks.
    if (audio) {
      audio.onpause = audio.onerror = audio.onended = null;
      try { audio.pause(); } catch (_) { /* already unavailable */ }
      try { audio.removeAttribute('src'); audio.load(); } catch (_) { /* release URL even if the media element is unavailable */ }
    }
    if (this.url) this.env.URL.revokeObjectURL(this.url);
    this.url = null;
  }
  clear() {
    this.stopAudio();
    const session = this.env.navigator?.mediaSession;
    if (this.ownsMedia() && !this.otherMediaActive()) {
      for (const action of this.actions) {
        try { session.setActionHandler(action, null); } catch (_) { /* unsupported */ }
      }
      try { session.metadata = null; session.playbackState = 'none'; } catch (_) { /* optional */ }
    }
    this.actions.clear();
    this.metadata = null;
  }
}
