import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBookBlockElement,
  isMarkdownFileName,
  isSupportedBookFileName,
  markdownToBookData,
  stripBookExtension,
  stripMarkdownInline,
} from '../src/markdown.js';

class FakeClassList {
  constructor() { this.values = []; }
  add(...values) { this.values.push(...values); }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.classList = new FakeClassList();
    this.dataset = {};
    this.children = [];
    this.attributes = {};
    this._textContent = '';
  }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  set textContent(value) { this._textContent = String(value); this.children = []; }
  get textContent() { return this.children.length ? this.children.map(child => child.textContent).join('') : this._textContent; }
}

const fakeDocument = { createElement: tag => new FakeElement(tag) };

test('book import extensions accept TXT and both Markdown suffixes only', () => {
  for (const name of ['novel.txt', 'notes.md', 'BOOK.MARKDOWN']) assert.equal(isSupportedBookFileName(name), true);
  for (const name of ['page.html', 'archive.md.zip', 'README']) assert.equal(isSupportedBookFileName(name), false);
  assert.equal(isMarkdownFileName('notes.md'), true);
  assert.equal(isMarkdownFileName('novel.txt'), false);
  assert.equal(stripBookExtension('月下.MARKDOWN'), '月下');
});

test('Markdown parser creates distinguishable blocks and heading TOC entries', () => {
  const source = [
    '# 月下序章',
    '',
    '普通 **粗體** 與 [連結](https://example.com)。',
    '',
    '- 第一項',
    '2. 第二項',
    '',
    '> 安全引用',
    '',
    '```js',
    '<script>alert("no")</script>',
    '```',
    '',
    '## 下一節',
  ].join('\n');

  const parsed = markdownToBookData(source);
  assert.deepEqual(parsed.blocks.map(block => block.type), [
    'heading', 'paragraph', 'list-item', 'list-item', 'blockquote', 'code', 'heading',
  ]);
  assert.deepEqual(parsed.chapters, [
    { title: '月下序章', idx: 0, level: 1 },
    { title: '下一節', idx: 6, level: 2 },
  ]);
  assert.equal(parsed.blocks[2].ordered, false);
  assert.equal(parsed.blocks[3].ordered, true);
  assert.equal(parsed.blocks[5].language, 'js');
  assert.equal(parsed.blocks[5].text, '<script>alert("no")</script>');
  assert.deepEqual(parsed.paragraphs, parsed.blocks.map(block => block.text));
});

test('TTS text removes Markdown syntax while preserving readable content', () => {
  assert.equal(
    stripMarkdownInline('**粗體**、_斜體_、~~刪除~~、`程式`、[官網](https://example.com) 與 ![月亮](moon.png)'),
    '粗體、斜體、刪除、程式、官網 與 月亮',
  );

  const parsed = markdownToBookData('# 標題\n\n- **項目**\n\n> `引用`');
  assert.deepEqual(parsed.paragraphs, ['標題', '項目', '引用']);
});

test('Markdown rendering uses textContent and never interprets script or HTML', () => {
  const code = createBookBlockElement(
    { type: 'code', text: '<script>alert(1)</script>', language: 'html' },
    3,
    fakeDocument,
  );
  assert.equal(code.tagName, 'PRE');
  assert.equal(code.children[0].tagName, 'CODE');
  assert.equal(code.textContent, '<script>alert(1)</script>');
  assert.equal(code.children.length, 1);
  assert.deepEqual(code.classList.values, ['para', 'md-code']);
  assert.equal(code.dataset.paraIdx, '3');

  const heading = createBookBlockElement({ type: 'heading', text: '<img src=x onerror=alert(1)>', level: 2 }, 0, fakeDocument);
  assert.equal(heading.tagName, 'H2');
  assert.equal(heading.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(heading.children.length, 0);
});

test('legacy TXT paragraph strings still render unchanged', () => {
  const paragraph = createBookBlockElement('舊版 IndexedDB 純文字段落', 7, fakeDocument);
  assert.equal(paragraph.tagName, 'P');
  assert.equal(paragraph.textContent, '舊版 IndexedDB 純文字段落');
  assert.deepEqual(paragraph.classList.values, ['para', 'md-paragraph']);
  assert.equal(paragraph.dataset.paraIdx, '7');
});

test('setext headings and multiline paragraphs are supported', () => {
  const parsed = markdownToBookData('主標題\n===\n\n第一行\n第二行\n\n副標題\n---');
  assert.deepEqual(parsed.blocks.map(block => [block.type, block.text, block.level]), [
    ['heading', '主標題', 1],
    ['paragraph', '第一行 第二行', undefined],
    ['heading', '副標題', 2],
  ]);
});
