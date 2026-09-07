// One persistent media element: keep it outside the re-rendered reader DOM.
export class BookAudioPlayer {
  constructor({ audio, storage, platform = {}, urls, changed = () => {}, deadline = () => false, beforePlay = () => {} }) {
    Object.assign(this, { audio, storage, platform, urls, changed, deadline, beforePlay });
    this.bookId = null;
    this.url = null;
    this.name = '';
    this.notice = '';
    this.loading = false;
    this.restored = false;
    this.generation = 0;
    this.lastSaved = 0;
    audio.preload = 'metadata';
    audio.preservesPitch = true;
    audio.addEventListener('loadedmetadata', () => {
      if (!this.bookId) return;
      const position = Number(this.read(this.key('position'))) || 0;
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        audio.currentTime = Math.max(0, Math.min(position, audio.duration));
        this.restored = true;
      }
      this.applyRate();
      this.changed();
    });
    audio.addEventListener('timeupdate', () => {
      if (this.deadline()) return;
      if (Date.now() - this.lastSaved > 2000) this.save();
      this.syncPosition();
      this.changed();
    });
    audio.addEventListener('playing', () => {
      this.loading = false;
      if (this.deadline()) return;
      this.notice = '';
      this.syncSession('playing');
      this.changed();
    });
    audio.addEventListener('pause', () => {
      this.loading = false;
      this.save();
      this.syncSession('paused');
      this.changed();
    });
    audio.addEventListener('waiting', () => {
      this.notice = '音訊緩衝中…';
      this.changed();
    });
    audio.addEventListener('ended', () => {
      this.loading = false;
      this.notice = '本書音訊播放完畢';
      this.write(this.key('position'), '0');
      this.syncSession('paused');
      this.changed();
    });
    audio.addEventListener('error', () => {
      if (!this.bookId) return;
      this.loading = false;
      this.audio.pause();
      this.notice = '音訊無法播放，請匯入可播放的 M4A 或 MP3 檔';
      this.syncSession('paused');
      this.changed();
    });
  }
  get isPlaying() { return this.loading || (!this.audio.paused && !this.audio.ended); }
  get rate() { return this.audio.playbackRate; }
  key(kind) { return `book-audio:${kind}:${this.bookId}`; }
  read(key) { try { return this.storage.getItem(key); } catch (_) { return null; } }
  write(key, value) { try { this.storage.setItem(key, value); } catch (_) { /* in-memory playback still works */ } }
  attach(book, record) {
    this.detach();
    if (!record?.blob) return;
    this.bookId = book.id;
    this.title = book.title;
    this.name = record.name;
    this.url = this.urls.createObjectURL(record.blob);
    this.audio.src = this.url;
    this.applyRate();
    this.audio.load();
    this.changed();
  }
  applyRate() {
    const value = Number(this.read('book-audio:rate')) || 1;
    this.audio.playbackRate = Math.max(0.5, Math.min(4, value));
    this.audio.preservesPitch = true;
  }
  setRate(value) {
    const rate = Math.max(0.5, Math.min(4, Number(value) || 1));
    this.write('book-audio:rate', String(rate));
    this.applyRate();
    this.syncPosition();
    this.changed();
  }
  async play() {
    if (!this.bookId || this.deadline()) return;
    this.beforePlay();
    const generation = this.generation;
    this.loading = true;
    this.notice = '正在啟動音訊…';
    try {
      if (this.audio.ended) this.seekTo(0);
      try { if (this.platform.audioSession) this.platform.audioSession.type = 'playback'; } catch (_) {}
      this.installSession();
      this.changed();
      await this.audio.play(); // Called synchronously from a user/Media Session action.
      if (generation !== this.generation) return;
      this.loading = false;
      this.notice = '';
      this.changed();
    } catch (_) {
      if (generation !== this.generation) return;
      this.loading = false;
      this.notice = '播放未啟動，請再點播放；若仍失敗請重新開啟本書';
      this.syncSession('paused');
      this.changed();
    }
  }
  pause() {
    this.generation++;
    this.loading = false;
    this.audio.pause();
    this.save();
    this.syncSession('paused');
    this.changed();
  }
  stop() { this.pause(); this.seekTo(0); }
  seekTo(value) {
    if (!Number.isFinite(this.audio.duration) || this.audio.duration <= 0) return;
    this.audio.currentTime = Math.max(0, Math.min(this.audio.duration, Number(value) || 0));
    this.save();
    this.syncPosition();
    this.changed();
  }
  skip(seconds) { this.seekTo(this.audio.currentTime + seconds); }
  save() {
    if (!this.bookId || !this.restored) return;
    this.write(this.key('position'), String(this.audio.ended ? 0 : this.audio.currentTime));
    this.lastSaved = Date.now();
  }
  installSession() {
    const session = this.platform.mediaSession;
    if (!session) return;
    try {
      if (this.platform.MediaMetadata) session.metadata = new this.platform.MediaMetadata({ title: this.title, artist: 'LunaShelf', album: this.name });
    } catch (_) {}
    const actions = {
      play: () => this.play(), pause: () => this.pause(), stop: () => this.stop(),
      seekbackward: details => this.skip(-(details.seekOffset || 15)),
      seekforward: details => this.skip(details.seekOffset || 15),
      seekto: details => this.seekTo(details.seekTime),
    };
    for (const [name, handler] of Object.entries(actions)) {
      try { session.setActionHandler(name, handler); } catch (_) { /* unsupported action */ }
    }
    this.syncPosition();
  }
  syncSession(value) {
    if (!this.bookId) return;
    try { if (this.platform.mediaSession) this.platform.mediaSession.playbackState = value; } catch (_) {}
  }
  syncPosition() {
    const { duration, currentTime, playbackRate } = this.audio;
    if (!this.bookId || !Number.isFinite(duration) || duration <= 0) return;
    try { this.platform.mediaSession?.setPositionState?.({ duration, position: Math.max(0, Math.min(duration, currentTime)), playbackRate }); } catch (_) {}
  }
  detach() {
    this.pause();
    this.bookId = null;
    this.restored = false;
    this.name = '';
    this.notice = '';
    this.audio.removeAttribute('src');
    this.audio.load();
    if (this.url) this.urls.revokeObjectURL(this.url);
    this.url = null;
    this.releaseSession();
  }
  releaseSession() {
    const session = this.platform.mediaSession;
    if (session) {
      for (const name of ['play', 'pause', 'stop', 'seekbackward', 'seekforward', 'seekto']) {
        try { session.setActionHandler(name, null); } catch (_) {}
      }
      try { session.metadata = null; session.playbackState = 'none'; session.setPositionState?.(); } catch (_) {}
    }
  }
}

export function audioTime(value) {
  const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, s = seconds % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
