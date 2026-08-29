import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBookBlockElement,
  isMarkdownFileName,
  isSupportedBookFileName,
  markdownToBookData,
  parseMarkdownInline,
  stripBookExtension,
  stripMarkdownInline,
} from '../src/markdown.js';
import {
  getTableLayoutPresentation,
  normalizeTableLayoutMode,
} from '../src/table-layout.js';

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

const fakeDocument = {
  createElement: tag => new FakeElement(tag),
  createTextNode: text => ({ nodeType: 3, textContent: String(text) }),
};

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

test('GFM tables parse alignment, escaped pipes, code pipes, and uneven rows', () => {
  const source = [
    '| Name | Value | Notes |',
    '| :--- | ---: | :---: |',
    '| alpha | 12 | escaped \\| pipe |',
    '| beta | `a | b` | **bold** and [site](https://example.com) |',
    '| short |',
  ].join('\n');
  const parsed = markdownToBookData(source);

  assert.equal(parsed.blocks.length, 1);
  const table = parsed.blocks[0];
  assert.equal(table.type, 'table');
  assert.deepEqual(table.alignments, ['left', 'right', 'center']);
  assert.deepEqual(table.header.map(cell => cell.text), ['Name', 'Value', 'Notes']);
  assert.deepEqual(table.rows[0].map(cell => cell.text), ['alpha', '12', 'escaped | pipe']);
  assert.deepEqual(table.rows[1].map(cell => cell.text), ['beta', 'a | b', 'bold and site']);
  assert.deepEqual(table.rows[2].map(cell => cell.text), ['short', '', '']);
  assert.equal(parsed.paragraphs[0], 'Name；Value；Notes。alpha；12；escaped | pipe。beta；a | b；bold and site。short');
});

test('long tables are split into page-friendly chunks with repeated headers', () => {
  const rows = Array.from({ length: 13 }, (_, i) => `| row ${i + 1} | ${i + 1} |`);
  const parsed = markdownToBookData(['| Item | Count |', '| --- | ---: |', ...rows].join('\n'));
  assert.deepEqual(parsed.blocks.map(block => block.rows.length), [5, 5, 3]);
  assert.ok(parsed.blocks.every(block => block.type === 'table'));
  assert.ok(parsed.blocks.every(block => block.header[0].text === 'Item'));
  assert.deepEqual(parsed.blocks.map(block => block.tableChunk), [0, 1, 2]);
});

test('table rendering creates semantic safe DOM and never uses imported HTML', () => {
  const parsed = markdownToBookData([
    '| **Heading** | Link |',
    '| --- | --- |',
    '| <img src=x onerror=alert(1)>safe | [open](javascript:alert(1)) |',
  ].join('\n'));
  const wrapper = createBookBlockElement(parsed.blocks[0], 4, fakeDocument);
  const table = wrapper.children[0];

  assert.equal(wrapper.tagName, 'DIV');
  assert.equal(table.tagName, 'TABLE');
  assert.equal(table.children[0].tagName, 'THEAD');
  assert.equal(table.children[1].tagName, 'TBODY');
  assert.equal(table.children[0].children[0].children[0].tagName, 'TH');
  assert.equal(table.children[1].children[0].children[0].tagName, 'TD');
  assert.equal(table.children[1].children[0].children[0].textContent, 'safe');
  assert.equal(table.children[1].children[0].children[1].textContent, 'open');
  assert.equal(table.children[1].children[0].children[1].children[0].tagName, 'SPAN');
  assert.equal(wrapper.dataset.paraIdx, '4');
  assert.equal(wrapper.classList.values.includes('md-table-bilingual'), true);
  assert.equal(table.children[1].children[0].children[0].attributes['data-label'], 'Heading');
  assert.equal(table.children[1].children[0].children[1].attributes['data-label'], 'Link');

  const threeColumn = markdownToBookData('| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |');
  const standardWrapper = createBookBlockElement(threeColumn.blocks[0], 5, fakeDocument);
  assert.equal(standardWrapper.classList.values.includes('md-table-bilingual'), false);
});

test('bilingual table layout mode is deterministic and defaults safely', () => {
  assert.equal(normalizeTableLayoutMode('bilingual'), 'bilingual');
  for (const value of ['standard', '', null, 'cards']) {
    assert.equal(normalizeTableLayoutMode(value), 'standard');
  }
  assert.deepEqual(getTableLayoutPresentation('bilingual'), {
    mode: 'bilingual',
    className: 'table-layout-bilingual',
  });
  assert.deepEqual(getTableLayoutPresentation('unexpected'), {
    mode: 'standard',
    className: 'table-layout-standard',
  });
});

test('safe inline renderer preserves emphasis, code, and allowed links', () => {
  const nodes = parseMarkdownInline('A **strong** *em* ~~gone~~ `x < y` [safe](https://example.com) <script>bad()</script>');
  assert.deepEqual(nodes.map(node => node.type), ['text', 'strong', 'text', 'em', 'text', 'del', 'text', 'code', 'text', 'link', 'text']);

  const paragraph = createBookBlockElement({
    type: 'paragraph',
    text: 'A strong em gone x < y safe bad()',
    inline: 'A **strong** *em* ~~gone~~ `x < y` [safe](https://example.com) <script>bad()</script>',
  }, 0, fakeDocument);
  assert.equal(paragraph.children.some(child => child.tagName === 'STRONG'), true);
  assert.equal(paragraph.children.some(child => child.tagName === 'EM'), true);
  assert.equal(paragraph.children.some(child => child.tagName === 'DEL'), true);
  assert.equal(paragraph.children.some(child => child.tagName === 'CODE'), true);
  const link = paragraph.children.find(child => child.tagName === 'A');
  assert.equal(link.attributes.href, 'https://example.com');
  assert.equal(link.attributes.rel, 'noopener noreferrer');
  assert.equal(paragraph.textContent, 'A strong em gone x < y safe bad()');
});
