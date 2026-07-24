import type { RichTextRun, RichTextValue } from './types';

const RT_PREFIX = '__rt__';

const RUN_FORMAT_KEYS = ['bold', 'italic', 'strikethrough', 'textColor', 'fontFamily', 'fontSize'] as const;

export function richTextKey(colId: string): string {
  return RT_PREFIX + colId;
}

export function isRichTextKey(key: string): boolean {
  return key.startsWith(RT_PREFIX);
}

export function plainTextFromRuns(runs: RichTextRun[]): string {
  return runs.map((r) => r.text).join('');
}

export function runsFromPlainText(text: string, defaultFormat?: Partial<RichTextRun>): RichTextRun[] {
  if (!text) return [];
  return [{ text, ...defaultFormat }];
}

export function isPlainRuns(runs: RichTextRun[]): boolean {
  return runs.every(
    (r) => !r.bold && !r.italic && !r.strikethrough && !r.textColor && !r.fontFamily && !r.fontSize
  );
}

function runFormatsEqual(a: Partial<RichTextRun>, b: Partial<RichTextRun>): boolean {
  return (
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.strikethrough === !!b.strikethrough &&
    (a.textColor || '') === (b.textColor || '') &&
    (a.fontFamily || '') === (b.fontFamily || '') &&
    (a.fontSize || 0) === (b.fontSize || 0)
  );
}

function getRunFormat(run: RichTextRun): Partial<RichTextRun> {
  const f: Partial<RichTextRun> = {};
  if (run.bold) f.bold = true;
  if (run.italic) f.italic = true;
  if (run.strikethrough) f.strikethrough = true;
  if (run.textColor) f.textColor = run.textColor;
  if (run.fontFamily) f.fontFamily = run.fontFamily;
  if (run.fontSize) f.fontSize = run.fontSize;
  return f;
}

export function normalizeRuns(runs: RichTextRun[]): RichTextRun[] {
  const result: RichTextRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const last = result[result.length - 1];
    if (last && runFormatsEqual(getRunFormat(last), getRunFormat(run))) {
      last.text += run.text;
    } else {
      result.push({ ...run });
    }
  }
  return result;
}

export function applyFormatToRange(
  runs: RichTextRun[],
  start: number,
  end: number,
  format: Partial<RichTextRun>
): RichTextRun[] {
  if (start === end) return runs;
  const result: RichTextRun[] = [];
  let offset = 0;

  for (const run of runs) {
    const runStart = offset;
    const runEnd = offset + run.text.length;
    offset = runEnd;

    if (runEnd <= start || runStart >= end) {
      // Outside selection — keep as-is
      result.push({ ...run });
      continue;
    }

    // Before selection part
    if (runStart < start) {
      result.push({ ...run, text: run.text.slice(0, start - runStart) });
    }

    // Selected part — apply/toggle format
    const selStart = Math.max(0, start - runStart);
    const selEnd = Math.min(run.text.length, end - runStart);
    const selectedRun: RichTextRun = { ...run, text: run.text.slice(selStart, selEnd) };

    for (const key of RUN_FORMAT_KEYS) {
      if (!(key in format)) continue;
      const value = format[key];
      if (value === undefined || value === null) {
        delete selectedRun[key];
      } else if (key === 'bold' || key === 'italic' || key === 'strikethrough') {
        selectedRun[key] = value as boolean;
      } else if (key === 'fontSize') {
        selectedRun[key] = value as number;
      } else {
        selectedRun[key] = value as string;
      }
    }
    result.push(selectedRun);

    // After selection part
    if (runEnd > end) {
      result.push({ ...run, text: run.text.slice(end - runStart) });
    }
  }

  return normalizeRuns(result);
}

export function getFormatAtOffset(runs: RichTextRun[], offset: number): Partial<RichTextRun> {
  let pos = 0;
  for (const run of runs) {
    pos += run.text.length;
    if (pos > offset) return getRunFormat(run);
  }
  if (runs.length > 0) return getRunFormat(runs[runs.length - 1]);
  return {};
}

export function isAllBold(runs: RichTextRun[], start: number, end: number): boolean {
  if (start === end) {
    const fmt = getFormatAtOffset(runs, start);
    return !!fmt.bold;
  }
  let offset = 0;
  for (const run of runs) {
    const runEnd = offset + run.text.length;
    if (runEnd > start && offset < end) {
      if (!run.bold) return false;
    }
    offset = runEnd;
  }
  return true;
}

export function isAllItalic(runs: RichTextRun[], start: number, end: number): boolean {
  if (start === end) {
    const fmt = getFormatAtOffset(runs, start);
    return !!fmt.italic;
  }
  let offset = 0;
  for (const run of runs) {
    const runEnd = offset + run.text.length;
    if (runEnd > start && offset < end) {
      if (!run.italic) return false;
    }
    offset = runEnd;
  }
  return true;
}

export function isAllStrikethrough(runs: RichTextRun[], start: number, end: number): boolean {
  if (start === end) {
    const fmt = getFormatAtOffset(runs, start);
    return !!fmt.strikethrough;
  }
  let offset = 0;
  for (const run of runs) {
    const runEnd = offset + run.text.length;
    if (runEnd > start && offset < end) {
      if (!run.strikethrough) return false;
    }
    offset = runEnd;
  }
  return true;
}

// --- DOM Conversion ---

export function runsToHtml(runs: RichTextRun[]): string {
  if (runs.length === 0) return '';
  return runs
    .map((run) => {
      const styles: string[] = [];
      if (run.bold) styles.push('font-weight:bold');
      if (run.italic) styles.push('font-style:italic');
      if (run.strikethrough) styles.push('text-decoration:line-through');
      if (run.textColor) styles.push(`color:${run.textColor}`);
      if (run.fontFamily) styles.push(`font-family:${run.fontFamily}`);
      if (run.fontSize) styles.push(`font-size:${run.fontSize}px`);
      const text = run.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      if (styles.length === 0) return text;
      return `<span style="${styles.join(';')}">${text}</span>`;
    })
    .join('');
}

export function htmlToRuns(html: string): RichTextRun[] {
  if (!html || html === '<br>') return [{ text: '' }];

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<body>${html}</body>`, 'text/html');
  const runs: RichTextRun[] = [];

  function walkNode(node: Node, inheritedFormat: Partial<RichTextRun>) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      if (text) runs.push({ text, ...inheritedFormat });
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const format = { ...inheritedFormat };

    // Handle semantic tags
    const tag = el.tagName.toLowerCase();
    if (tag === 'b' || tag === 'strong') format.bold = true;
    if (tag === 'i' || tag === 'em') format.italic = true;
    if (tag === 's' || tag === 'del' || tag === 'strike') format.strikethrough = true;
    if (tag === 'br') {
      runs.push({ text: '\n', ...inheritedFormat });
      return;
    }

    // Handle inline styles
    const style = el.style;
    if (style.fontWeight === 'bold' || parseInt(style.fontWeight) >= 700) format.bold = true;
    if (style.fontStyle === 'italic') format.italic = true;
    if (style.textDecoration?.includes('line-through')) format.strikethrough = true;
    if (style.color) format.textColor = style.color;
    if (style.fontFamily) format.fontFamily = style.fontFamily;
    if (style.fontSize) {
      const size = parseInt(style.fontSize);
      if (!isNaN(size)) format.fontSize = size;
    }

    for (const child of Array.from(el.childNodes)) {
      walkNode(child, format);
    }

    // Block-level elements add newline (except the root body)
    if (tag === 'div' || tag === 'p') {
      const lastRun = runs[runs.length - 1];
      if (lastRun && !lastRun.text.endsWith('\n')) {
        runs.push({ text: '\n' });
      }
    }
  }

  for (const child of Array.from(doc.body.childNodes)) {
    walkNode(child, {});
  }

  // Remove trailing newline
  if (runs.length > 0) {
    const last = runs[runs.length - 1];
    if (last.text === '\n' && runs.length > 1) runs.pop();
    else if (last.text.endsWith('\n')) last.text = last.text.slice(0, -1);
  }

  return normalizeRuns(runs);
}

// --- Selection utilities for contentEditable ---

export function saveSelection(el: HTMLElement): { start: number; end: number } | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return null;

  const preRange = document.createRange();
  preRange.selectNodeContents(el);
  preRange.setEnd(range.startContainer, range.startOffset);
  const start = preRange.toString().length;

  preRange.setEnd(range.endContainer, range.endOffset);
  const end = preRange.toString().length;

  return { start, end };
}

export function restoreSelection(el: HTMLElement, offsets: { start: number; end: number }) {
  const sel = window.getSelection();
  if (!sel) return;

  let charIndex = 0;
  const range = document.createRange();
  let startSet = false;

  function walk(node: Node): boolean {
    if (node.nodeType === Node.TEXT_NODE) {
      const textLen = (node.textContent || '').length;
      if (!startSet && charIndex + textLen >= offsets.start) {
        range.setStart(node, offsets.start - charIndex);
        startSet = true;
      }
      if (startSet && charIndex + textLen >= offsets.end) {
        range.setEnd(node, offsets.end - charIndex);
        return true;
      }
      charIndex += textLen;
    } else {
      for (const child of Array.from(node.childNodes)) {
        if (walk(child)) return true;
      }
    }
    return false;
  }

  walk(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

export function getRichText(rowData: Record<string, unknown> | undefined, colId: string): RichTextValue | undefined {
  if (!rowData) return undefined;
  const rt = rowData[richTextKey(colId)];
  return Array.isArray(rt) ? rt as RichTextValue : undefined;
}
