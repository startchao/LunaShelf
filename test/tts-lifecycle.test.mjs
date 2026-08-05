import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TtsPlaybackGeneration } from '../src/tts-playback-generation.js';

test('a stale utterance cannot clear or replace the current generation', () => {
  const playback = new TtsPlaybackGeneration();
  const stale = { id: 'stale' };
  const fresh = { id: 'fresh' };

  const staleGeneration = playback.begin();
  assert.equal(playback.set(stale, staleGeneration), true);

  const freshGeneration = playback.begin();
  assert.equal(playback.set(fresh, freshGeneration), true);
  assert.equal(playback.isCurrent(stale, staleGeneration), false);
  assert.equal(playback.clear(stale, staleGeneration), false);
  assert.equal(playback.isCurrent(fresh, freshGeneration), true);
  assert.equal(playback.utterance, fresh);
});

test('an invalidated generation cannot install a delayed utterance', () => {
  const playback = new TtsPlaybackGeneration();
  const oldGeneration = playback.begin();
  playback.begin();

  assert.equal(playback.set({ id: 'late' }, oldGeneration), false);
  assert.equal(playback.utterance, null);
});

test('main TTS lifecycle has no automatic foreground resume or retry path', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const visibilityHandler = source.slice(source.indexOf("document.addEventListener('visibilitychange'"));
  const playMethod = source.slice(source.indexOf('  play() {'), source.indexOf('  armStartWatchdog(', source.indexOf('  play() {')));
  const watchdogMethod = source.slice(source.indexOf('  armStartWatchdog('), source.indexOf('  speakNext(', source.indexOf('  armStartWatchdog(')));

  assert.match(visibilityHandler, /visibilityState === 'hidden'\) tts\.suspendForBackground\(\)/);
  assert.doesNotMatch(visibilityHandler, /visibilityState === 'visible'/);
  assert.doesNotMatch(source, /autoResumeWanted|resumeAfterInterruption|retryActiveSegment|speechSynthesis\.resume/);
  assert.ok(playMethod.indexOf('invalidateSpeechState()') < playMethod.indexOf('speakNext(generation)'), 'Play must invalidate stale app state before creating the new utterance');
  assert.doesNotMatch(playMethod, /speechSynthesis\.cancel\(\)|cancelSpeechEngine\(\)/, 'Play must not cancel native speech immediately before speak');
  assert.doesNotMatch(watchdogMethod, /speakNext|speechSynthesis\.speak\(|retryActiveSegment/);
});

test('pause, stop, and background suspension invalidate before canceling speech', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const queue = source.slice(source.indexOf('class SpeechQueue'));
  const invalidate = queue.slice(queue.indexOf('  invalidateSpeechState() {'), queue.indexOf('  cancelSpeechEngine() {', queue.indexOf('  invalidateSpeechState() {')));
  const cancel = queue.slice(queue.indexOf('  cancelSpeechEngine() {'), queue.indexOf('  play() {', queue.indexOf('  cancelSpeechEngine() {')));
  const pause = queue.slice(queue.indexOf('  pause() {'), queue.indexOf('  stop() {', queue.indexOf('  pause() {')));
  const stop = queue.slice(queue.indexOf('  stop() {'), queue.indexOf('\n  }\n}', queue.indexOf('  stop() {')) + 4);
  const background = queue.slice(queue.indexOf('  suspendForBackground() {'), queue.indexOf('  pause() {', queue.indexOf('  suspendForBackground() {')));

  assert.match(invalidate, /playback\.begin\(\)/);
  assert.match(invalidate, /oldUtterance\.onend = null/);
  assert.match(invalidate, /oldUtterance\.onerror = null/);
  assert.doesNotMatch(invalidate, /speechSynthesis\.cancel\(\)/);
  assert.ok(cancel.indexOf('invalidateSpeechState()') < cancel.indexOf('speechSynthesis.cancel()'));
  for (const method of [pause, stop, background]) assert.match(method, /cancelSpeechEngine\(\)/);
  assert.doesNotMatch(pause + stop + background, /\bplay\(\)|speakNext\(/);
});
