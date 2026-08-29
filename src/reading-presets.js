export const READING_PRESET_IDS = ['novel', 'english'];

export const DEFAULT_READING_PRESETS = Object.freeze({
  novel: Object.freeze({
    fontFamily: 'serif',
    fontSize: 18,
    lineHeight: 1.3,
    paragraphSpacing: 0.5,
    marginPreset: 'standard',
    tableLayoutMode: 'standard',
  }),
  english: Object.freeze({
    fontFamily: 'english-serif',
    fontSize: 19,
    lineHeight: 1.55,
    paragraphSpacing: 0.7,
    marginPreset: 'standard',
    tableLayoutMode: 'bilingual',
  }),
});

const STORAGE_PREFIX = 'readingPreset.';
const ACTIVE_KEY = 'readingPresetMode';
const MARGINS = new Set(['narrow', 'standard', 'wide']);

export function normalizeReadingPresetId(value) {
  return value === 'english' ? 'english' : 'novel';
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

export function normalizeReadingPreset(value, id = 'novel') {
  const presetId = normalizeReadingPresetId(id);
  const fallback = DEFAULT_READING_PRESETS[presetId];
  const source = value && typeof value === 'object' ? value : {};
  const fontFamily = typeof source.fontFamily === 'string' && source.fontFamily.trim()
    ? source.fontFamily.trim()
    : fallback.fontFamily;
  return {
    fontFamily,
    fontSize: clampNumber(source.fontSize, 16, 34, fallback.fontSize),
    lineHeight: clampNumber(source.lineHeight, 1, 2.5, fallback.lineHeight),
    paragraphSpacing: clampNumber(source.paragraphSpacing, 0, 2, fallback.paragraphSpacing),
    marginPreset: MARGINS.has(source.marginPreset) ? source.marginPreset : fallback.marginPreset,
    tableLayoutMode: source.tableLayoutMode === 'bilingual'
      ? 'bilingual'
      : source.tableLayoutMode === 'standard'
        ? 'standard'
        : fallback.tableLayoutMode,
  };
}

function readJson(storage, key) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function legacyNovelPreset(storage) {
  return normalizeReadingPreset({
    fontFamily: storage.getItem('fontFamily') || undefined,
    fontSize: storage.getItem('fontSize') || undefined,
    lineHeight: storage.getItem('lineHeight') || undefined,
    paragraphSpacing: storage.getItem('paragraphSpacing') || undefined,
    tableLayoutMode: storage.getItem('tableLayoutMode') || undefined,
  }, 'novel');
}

export function loadReadingPresets(storage) {
  const activeId = normalizeReadingPresetId(storage.getItem(ACTIVE_KEY));
  const savedNovel = readJson(storage, `${STORAGE_PREFIX}novel`);
  const presets = {
    novel: savedNovel
      ? normalizeReadingPreset(savedNovel, 'novel')
      : legacyNovelPreset(storage),
    english: normalizeReadingPreset(readJson(storage, `${STORAGE_PREFIX}english`), 'english'),
  };
  saveReadingPreset(storage, 'novel', presets.novel);
  saveReadingPreset(storage, 'english', presets.english);
  storage.setItem(ACTIVE_KEY, activeId);
  return { activeId, presets };
}

export function saveReadingPreset(storage, id, value) {
  const presetId = normalizeReadingPresetId(id);
  const preset = normalizeReadingPreset(value, presetId);
  storage.setItem(`${STORAGE_PREFIX}${presetId}`, JSON.stringify(preset));
  return preset;
}

export function setActiveReadingPreset(storage, id) {
  const presetId = normalizeReadingPresetId(id);
  storage.setItem(ACTIVE_KEY, presetId);
  return presetId;
}

export function readingMarginCss(value) {
  return { narrow: '12px', standard: '15px', wide: '24px' }[value] || '15px';
}
