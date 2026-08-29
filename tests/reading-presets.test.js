import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_READING_PRESETS,
  loadReadingPresets,
  normalizeReadingPreset,
  readingMarginCss,
  saveReadingPreset,
  setActiveReadingPreset,
} from '../src/reading-presets.js';

class MemoryStorage {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

test('creates independent novel and English defaults', () => {
  const storage = new MemoryStorage();
  const result = loadReadingPresets(storage);

  assert.equal(result.activeId, 'novel');
  assert.deepEqual(result.presets.novel, DEFAULT_READING_PRESETS.novel);
  assert.deepEqual(result.presets.english, DEFAULT_READING_PRESETS.english);
  assert.equal(result.presets.english.fontFamily, 'english-serif');
  assert.equal(result.presets.english.tableLayoutMode, 'bilingual');
});

test('migrates legacy layout into novel preset without changing English defaults', () => {
  const storage = new MemoryStorage({
    fontFamily: 'custom-tony',
    fontSize: '22',
    lineHeight: '1.8',
    paragraphSpacing: '0.9',
    tableLayoutMode: 'bilingual',
  });
  const { presets } = loadReadingPresets(storage);

  assert.deepEqual(presets.novel, {
    fontFamily: 'custom-tony',
    fontSize: 22,
    lineHeight: 1.8,
    paragraphSpacing: 0.9,
    marginPreset: 'standard',
    tableLayoutMode: 'bilingual',
  });
  assert.deepEqual(presets.english, DEFAULT_READING_PRESETS.english);
});

test('saves changes to one preset without mutating the other', () => {
  const storage = new MemoryStorage();
  const { presets } = loadReadingPresets(storage);
  const originalNovel = structuredClone(presets.novel);

  const english = saveReadingPreset(storage, 'english', {
    ...presets.english,
    fontFamily: 'custom-source-serif',
    fontSize: 21,
    marginPreset: 'wide',
  });
  setActiveReadingPreset(storage, 'english');
  const reloaded = loadReadingPresets(storage);

  assert.deepEqual(reloaded.presets.novel, originalNovel);
  assert.deepEqual(reloaded.presets.english, english);
  assert.equal(reloaded.activeId, 'english');
});

test('normalizes corrupt and out-of-range values safely', () => {
  const normalized = normalizeReadingPreset({
    fontFamily: '',
    fontSize: 99,
    lineHeight: -2,
    paragraphSpacing: 'bad',
    marginPreset: 'huge',
    tableLayoutMode: 'invalid',
  }, 'english');

  assert.equal(normalized.fontFamily, 'english-serif');
  assert.equal(normalized.fontSize, 34);
  assert.equal(normalized.lineHeight, 1);
  assert.equal(normalized.paragraphSpacing, 0.7);
  assert.equal(normalized.marginPreset, 'standard');
  assert.equal(normalized.tableLayoutMode, 'bilingual');
});

test('maps margin presets to bounded CSS values', () => {
  assert.equal(readingMarginCss('narrow'), '12px');
  assert.equal(readingMarginCss('wide'), '24px');
  assert.equal(readingMarginCss('unexpected'), '15px');
});
