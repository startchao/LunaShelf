export class TtsPlaybackGeneration {
  constructor() {
    this.value = 0;
    this.utterance = null;
  }

  begin() {
    this.value += 1;
    this.utterance = null;
    return this.value;
  }

  set(utterance, generation) {
    if (generation !== this.value) return false;
    this.utterance = utterance;
    return true;
  }

  isCurrent(utterance, generation) {
    return generation === this.value && utterance === this.utterance;
  }

  clear(utterance, generation) {
    if (!this.isCurrent(utterance, generation)) return false;
    this.utterance = null;
    return true;
  }
}
