const MARKDOWN_FILE_RE = /\.(?:md|markdown)$/i;

export function isMarkdownFileName(name) {
  return MARKDOWN_FILE_RE.test(String(name || ''));
}

export function isSupportedBookFileName(name) {
  return /\.(?:txt|md|markdown)$/i.test(String(name || ''));
}

export function stripBookExtension(name) {
  return String(name || '').replace(/\.(?:txt|md|markdown)$/i, '');
}

/**
 * Convert inline Markdown to the plain text used by the reader and TTS.
 * Raw HTML is discarded rather than interpreted. This is deliberately a
 * small, dependency-free subset suitable for locally imported novels.
 */
export function stripMarkdownInline(value) {
  let text = String(value ?? '');
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/!\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
  text = text.replace(/<((?:https?:\/\/|mailto:)[^>]+)>/gi, '$1');
  text = text.replace(/<[^>]*>/g, '');
  text = text.replace(/`+([^`]*?)`+/g, '$1');
  text = text.replace(/[*_~]+/g, '');
  text = text.replace(/\\([\\`*_[\]{}()#+\-.!>])/g, '$1');
  return text.replace(/\s+/g, ' ').trim();
}

function paragraphBlock(lines) {
  return { type: 'paragraph', text: stripMarkdownInline(lines.join(' ')) };
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

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      const headingText = stripMarkdownInline(heading[2]);
      if (headingText) blocks.push({ type: 'heading', text: headingText, level: heading[1].length });
      i += 1;
      continue;
    }

    if (i + 1 < lines.length && /^\s{0,3}(=+|-+)\s*$/.test(lines[i + 1]) && trimmed) {
      flushParagraph();
      const headingText = stripMarkdownInline(trimmed);
      if (headingText) {
        const level = lines[i + 1].trim().startsWith('=') ? 1 : 2;
        blocks.push({ type: 'heading', text: headingText, level });
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
      const quoteText = stripMarkdownInline(quoteLines.join(' '));
      if (quoteText) blocks.push({ type: 'blockquote', text: quoteText });
      continue;
    }

    const list = line.match(/^\s{0,3}([-+*]|(\d+)[.)])\s+(.+)$/);
    if (list) {
      flushParagraph();
      const itemText = stripMarkdownInline(list[3]);
      if (itemText) blocks.push({
        type: 'list-item',
        text: itemText,
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

/** Create one reader block without ever assigning imported content as HTML. */
export function createBookBlockElement(block, idx, doc = document) {
  const data = typeof block === 'string' ? { type: 'paragraph', text: block } : (block || {});
  let element;

  if (data.type === 'heading') {
    const level = Math.max(1, Math.min(6, Number(data.level) || 2));
    element = doc.createElement(`h${level}`);
    element.textContent = data.text || '';
  } else if (data.type === 'blockquote') {
    element = doc.createElement('blockquote');
    element.textContent = data.text || '';
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
      element.textContent = `${marker} ${data.text || ''}`;
    } else {
      element.textContent = data.text || '';
    }
  }

  element.classList.add('para', `md-${data.type || 'paragraph'}`);
  if (Number.isFinite(idx)) element.dataset.paraIdx = String(idx);
  return element;
}
