const MARKDOWN_FILE_RE = /\.(?:md|markdown)$/i;
const TABLE_ROWS_PER_BLOCK = 5;

export function isMarkdownFileName(name) {
  return MARKDOWN_FILE_RE.test(String(name || ''));
}

export function isSupportedBookFileName(name) {
  return /\.(?:txt|md|markdown)$/i.test(String(name || ''));
}

export function stripBookExtension(name) {
  return String(name || '').replace(/\.(?:txt|md|markdown)$/i, '');
}

function pushText(nodes, text) {
  if (!text) return;
  const last = nodes[nodes.length - 1];
  if (last?.type === 'text') last.text += text;
  else nodes.push({ type: 'text', text });
}

function isEscaped(source, index) {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && source[i] === '\\'; i--) slashes += 1;
  return slashes % 2 === 1;
}

function findClosing(source, marker, from) {
  let at = source.indexOf(marker, from);
  while (at >= 0 && isEscaped(source, at)) at = source.indexOf(marker, at + marker.length);
  return at;
}

function findLinkDestinationEnd(source, from) {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    if (source[i] === '\\') { i += 1; continue; }
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

/** Parse a bounded inline Markdown subset into safe render tokens. */
export function parseMarkdownInline(value) {
  const source = String(value ?? '');
  const nodes = [];
  let i = 0;

  while (i < source.length) {
    if (source[i] === '\\' && i + 1 < source.length && /[\\`*_[\]{}()#+\-.!>|~]/.test(source[i + 1])) {
      pushText(nodes, source[i + 1]);
      i += 2;
      continue;
    }

    if (source[i] === '`') {
      const run = source.slice(i).match(/^`+/)?.[0] || '`';
      const close = findClosing(source, run, i + run.length);
      if (close >= 0) {
        let text = source.slice(i + run.length, close).replace(/[\r\n]+/g, ' ');
        if (/^\s.*\s$/.test(text) && /\S/.test(text)) text = text.slice(1, -1);
        nodes.push({ type: 'code', text });
        i = close + run.length;
        continue;
      }
    }

    const image = source.slice(i).match(/^!\[([^\]]*)\]\(/);
    const link = source.slice(i).match(/^\[([^\]]+)\]\(/);
    const match = image || link;
    if (match) {
      const destinationStart = i + match[0].length;
      const destinationEnd = findLinkDestinationEnd(source, destinationStart);
      if (destinationEnd >= 0) {
        const label = match[1].replace(/\\([\\`*_[\]{}()#+\-.!>|~])/g, '$1');
        const href = source.slice(destinationStart, destinationEnd).trim().replace(/^<|>$/g, '');
        if (image) nodes.push({ type: 'image-alt', text: label });
        else nodes.push({ type: 'link', href, children: parseMarkdownInline(label) });
        i = destinationEnd + 1;
        continue;
      }
    }

    const autoLink = source.slice(i).match(/^<((?:https?:\/\/|mailto:)[^ >]+)>/i);
    if (autoLink) {
      nodes.push({ type: 'link', href: autoLink[1], children: [{ type: 'text', text: autoLink[1] }] });
      i += autoLink[0].length;
      continue;
    }

    const html = source.slice(i).match(/^<!--(?:.|\n)*?-->|^<\/?[A-Za-z][^>]*>/);
    if (html) {
      i += html[0].length;
      continue;
    }

    const delimiter = source.startsWith('**', i) || source.startsWith('__', i) ? { marker: source.slice(i, i + 2), type: 'strong' }
      : source.startsWith('~~', i) ? { marker: '~~', type: 'del' }
        : source[i] === '*' || source[i] === '_' ? { marker: source[i], type: 'em' }
          : null;
    if (delimiter) {
      const close = findClosing(source, delimiter.marker, i + delimiter.marker.length);
      if (close > i + delimiter.marker.length) {
        nodes.push({
          type: delimiter.type,
          children: parseMarkdownInline(source.slice(i + delimiter.marker.length, close)),
        });
        i = close + delimiter.marker.length;
        continue;
      }
    }

    pushText(nodes, source[i]);
    i += 1;
  }
  return nodes;
}

function inlineNodesText(nodes) {
  return nodes.map(node => node.text ?? inlineNodesText(node.children || [])).join('');
}

/** Convert inline Markdown to plain reader/TTS text without interpreting HTML. */
export function stripMarkdownInline(value) {
  return inlineNodesText(parseMarkdownInline(value)).replace(/\s+/g, ' ').trim();
}

function paragraphBlock(lines) {
  const inline = lines.join(' ');
  return { type: 'paragraph', text: stripMarkdownInline(inline), inline };
}

function splitTableRow(line) {
  const source = String(line ?? '').trim();
  if (!source) return [];
  const cells = [];
  let cell = '';
  let codeRun = 0;
  let sawPipe = false;

  for (let i = 0; i < source.length;) {
    if (source[i] === '\\' && i + 1 < source.length) {
      cell += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (source[i] === '`') {
      const run = source.slice(i).match(/^`+/)?.[0].length || 1;
      codeRun = codeRun === run ? 0 : (codeRun || run);
      cell += source.slice(i, i + run);
      i += run;
      continue;
    }
    if (source[i] === '|' && !codeRun) {
      cells.push(cell.trim());
      cell = '';
      sawPipe = true;
      i += 1;
      continue;
    }
    cell += source[i];
    i += 1;
  }
  cells.push(cell.trim());
  if (!sawPipe) return [];
  if (source.startsWith('|')) cells.shift();
  if (source.endsWith('|') && !isEscaped(source, source.length - 1)) cells.pop();
  return cells;
}

function parseDelimiterRow(line) {
  const cells = splitTableRow(line);
  if (!cells.length || !cells.every(cell => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')))) return null;
  return cells.map(cell => {
    const clean = cell.replace(/\s+/g, '');
    if (clean.startsWith(':') && clean.endsWith(':')) return 'center';
    if (clean.endsWith(':')) return 'right';
    if (clean.startsWith(':')) return 'left';
    return null;
  });
}

function tableCell(source) {
  return { source, text: stripMarkdownInline(source) };
}

function tableSpeech(header, rows) {
  return [header, ...rows]
    .map(row => row.map(cell => cell.text).filter(Boolean).join('；'))
    .filter(Boolean)
    .join('。');
}

function appendTableBlocks(blocks, headerSources, alignments, rowSources) {
  const width = headerSources.length;
  const header = headerSources.map(tableCell);
  const normalizedRows = rowSources.map(row => Array.from({ length: width }, (_, i) => tableCell(row[i] || '')));
  const chunks = normalizedRows.length
    ? Array.from({ length: Math.ceil(normalizedRows.length / TABLE_ROWS_PER_BLOCK) }, (_, chunk) => normalizedRows.slice(chunk * TABLE_ROWS_PER_BLOCK, (chunk + 1) * TABLE_ROWS_PER_BLOCK))
    : [[]];
  chunks.forEach((rows, tableChunk) => blocks.push({
    type: 'table',
    header,
    rows,
    alignments,
    tableChunk,
    text: tableSpeech(header, rows),
  }));
}

/** Parse a safe, display-oriented Markdown subset into page-sized blocks. */
export function markdownToBookData(source) {
  const text = String(source ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!text) return { blocks: [], paragraphs: [], chapters: [] };

  const lines = text.split('\n');
  const blocks = [];
  let pending = [];
  const flushParagraph = () => {
    if (!pending.length) return;
    const block = paragraphBlock(pending);
    if (block.text) blocks.push(block);
    pending = [];
  };

  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      i += 1;
      continue;
    }

    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*$/);
    if (fence) {
      flushParagraph();
      const marker = fence[1][0];
      const minimum = fence[1].length;
      const codeLines = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${marker}{${minimum},}\\s*$`).test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: 'code', text: codeLines.join('\n'), language: fence[2] || '' });
      continue;
    }

    const headerCells = splitTableRow(line);
    const alignments = i + 1 < lines.length ? parseDelimiterRow(lines[i + 1]) : null;
    if (headerCells.length && alignments && headerCells.length === alignments.length) {
      flushParagraph();
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim()) {
        const row = splitTableRow(lines[i]);
        if (!row.length) break;
        rows.push(row);
        i += 1;
      }
      appendTableBlocks(blocks, headerCells, alignments, rows);
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      const headingText = stripMarkdownInline(heading[2]);
      if (headingText) blocks.push({ type: 'heading', text: headingText, inline: heading[2], level: heading[1].length });
      i += 1;
      continue;
    }

    if (i + 1 < lines.length && /^\s{0,3}(=+|-+)\s*$/.test(lines[i + 1]) && trimmed) {
      flushParagraph();
      const headingText = stripMarkdownInline(trimmed);
      if (headingText) {
        const level = lines[i + 1].trim().startsWith('=') ? 1 : 2;
        blocks.push({ type: 'heading', text: headingText, inline: trimmed, level });
      }
      i += 2;
      continue;
    }

    const quote = line.match(/^\s{0,3}>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      const quoteLines = [];
      while (i < lines.length) {
        const part = lines[i].match(/^\s{0,3}>\s?(.*)$/);
        if (!part) break;
        quoteLines.push(part[1]);
        i += 1;
      }
      const inline = quoteLines.join(' ');
      const quoteText = stripMarkdownInline(inline);
      if (quoteText) blocks.push({ type: 'blockquote', text: quoteText, inline });
      continue;
    }

    const list = line.match(/^\s{0,3}([-+*]|(\d+)[.)])\s+(.+)$/);
    if (list) {
      flushParagraph();
      const itemText = stripMarkdownInline(list[3]);
      if (itemText) blocks.push({
        type: 'list-item',
        text: itemText,
        inline: list[3],
        ordered: Boolean(list[2]),
        number: list[2] ? Number(list[2]) : undefined,
      });
      i += 1;
      continue;
    }

    if (/^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) {
      flushParagraph();
      i += 1;
      continue;
    }

    pending.push(trimmed);
    i += 1;
  }
  flushParagraph();

  const chapters = blocks
    .map((block, idx) => ({ block, idx }))
    .filter(({ block }) => block.type === 'heading')
    .map(({ block, idx }) => ({ title: block.text, idx, level: block.level }));

  return { blocks, paragraphs: blocks.map(block => block.text), chapters };
}

function isSafeLink(href) {
  return /^(?:https?:|mailto:)/i.test(String(href || '').trim());
}

function appendInlineNodes(element, nodes, doc) {
  for (const node of nodes) {
    if (node.type === 'text') {
      element.appendChild(doc.createTextNode(node.text));
      continue;
    }
    if (node.type === 'image-alt') {
      const span = doc.createElement('span');
      span.classList.add('md-image-alt');
      span.textContent = node.text;
      element.appendChild(span);
      continue;
    }
    const tags = { strong: 'strong', em: 'em', del: 'del', code: 'code' };
    if (tags[node.type]) {
      const child = doc.createElement(tags[node.type]);
      if (node.type === 'code') child.textContent = node.text;
      else appendInlineNodes(child, node.children || [], doc);
      element.appendChild(child);
      continue;
    }
    if (node.type === 'link') {
      const child = doc.createElement(isSafeLink(node.href) ? 'a' : 'span');
      if (isSafeLink(node.href)) {
        child.setAttribute('href', node.href);
        child.setAttribute('target', '_blank');
        child.setAttribute('rel', 'noopener noreferrer');
      } else child.classList.add('md-unsafe-link');
      appendInlineNodes(child, node.children || [], doc);
      element.appendChild(child);
    }
  }
}

function appendInline(element, source, fallback, doc) {
  if (typeof source !== 'string') element.textContent = fallback || '';
  else appendInlineNodes(element, parseMarkdownInline(source), doc);
}

function createTableElement(data, doc) {
  const wrapper = doc.createElement('div');
  if (data.header?.length === 2) wrapper.classList.add('md-table-bilingual');
  const table = doc.createElement('table');
  const thead = doc.createElement('thead');
  const headRow = doc.createElement('tr');
  data.header.forEach((cell, column) => {
    const th = doc.createElement('th');
    th.setAttribute('scope', 'col');
    if (data.alignments?.[column]) th.setAttribute('data-align', data.alignments[column]);
    appendInline(th, cell.source, cell.text, doc);
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = doc.createElement('tbody');
  data.rows.forEach(row => {
    const tr = doc.createElement('tr');
    row.forEach((cell, column) => {
      const td = doc.createElement('td');
      td.setAttribute('data-label', data.header?.[column]?.text || '');
      if (data.alignments?.[column]) td.setAttribute('data-align', data.alignments[column]);
      appendInline(td, cell.source, cell.text, doc);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrapper.appendChild(table);
  return wrapper;
}

/** Create one reader block without ever assigning imported content as HTML. */
export function createBookBlockElement(block, idx, doc = document) {
  const data = typeof block === 'string' ? { type: 'paragraph', text: block } : (block || {});
  let element;

  if (data.type === 'table') {
    element = createTableElement(data, doc);
  } else if (data.type === 'heading') {
    const level = Math.max(1, Math.min(6, Number(data.level) || 2));
    element = doc.createElement(`h${level}`);
    appendInline(element, data.inline, data.text, doc);
  } else if (data.type === 'blockquote') {
    element = doc.createElement('blockquote');
    appendInline(element, data.inline, data.text, doc);
  } else if (data.type === 'code') {
    element = doc.createElement('pre');
    const code = doc.createElement('code');
    code.textContent = data.text || '';
    if (data.language) code.setAttribute('data-language', data.language);
    element.appendChild(code);
  } else {
    element = doc.createElement('p');
    if (data.type === 'list-item') {
      const marker = data.ordered ? `${data.number || 1}.` : '•';
      element.appendChild(doc.createTextNode(`${marker} `));
      appendInline(element, data.inline, data.text, doc);
    } else appendInline(element, data.inline, data.text, doc);
  }

  element.classList.add('para', `md-${data.type || 'paragraph'}`);
  if (Number.isFinite(idx)) element.dataset.paraIdx = String(idx);
  return element;
}
