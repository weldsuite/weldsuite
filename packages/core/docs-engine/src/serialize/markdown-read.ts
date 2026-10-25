/**
 * Markdown in: CommonMark's blocks and inlines plus GitHub's tables, task
 * lists, strikethrough and bare links. Raw HTML is kept as text.
 */

import { cleanStoryText, LINE_BREAK, TAB } from '../model/chars';
import { ContentBuilder, type Fragment, type TableCellInput } from '../model/builder';
import { bulletList, checkList, numberedList } from '../model/defaults';
import { newId } from '../model/ids';
import { isSafeLink, type ListDef, type ParaProps, type TextStyle } from '../model/styles';

export interface MarkdownReadOptions {
  makeId?: () => string;
}

type MdBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; lines: string[] }
  | { type: 'quote'; blocks: MdBlock[] }
  | { type: 'hr' }
  | { type: 'list'; ordered: boolean; start: number; items: { blocks: MdBlock[]; checked?: boolean }[] }
  | { type: 'table'; rows: string[][]; align: (string | null)[] };

export function fromMarkdown(markdown: string, options: MarkdownReadOptions = {}): Fragment {
  const makeId = options.makeId ?? newId;
  const blocks = parseBlocks(markdown.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
  const lists: Record<string, ListDef> = {};
  const builder = new ContentBuilder(makeId);
  emitBlocks(blocks, builder, { lists, makeId }, {}, null);
  const content = builder.build();
  return Object.keys(lists).length ? { content, lists } : { content };
}

// ---------------------------------------------------------------- blocks

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`]*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_ITEM = /^( {0,3})([-+*]|\d{1,9}[.)])( +|$)/;
const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function parseBlocks(lines: string[]): MdBlock[] {
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length) blocks.push({ type: 'paragraph', text: para.join('\n') });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) {
      endPara();
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      endPara();
      const marker = fence[1]!;
      const code: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i]!)) code.push(lines[i++]!);
      blocks.push({ type: 'code', lines: code });
      continue;
    }
    // Setext headings underline the paragraph just collected.
    if (para.length && /^ {0,3}(=+|-+)\s*$/.test(line)) {
      blocks.push({ type: 'heading', level: line.trim()[0] === '=' ? 1 : 2, text: para.join('\n') });
      para = [];
      continue;
    }
    const atx = ATX.exec(line);
    if (atx) {
      endPara();
      blocks.push({ type: 'heading', level: atx[1]!.length, text: atx[2] ?? '' });
      continue;
    }
    if (HR.test(line)) {
      endPara();
      blocks.push({ type: 'hr' });
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      endPara();
      const quoted: string[] = [];
      while (i < lines.length && lines[i]!.trim() && (/^ {0,3}>/.test(lines[i]!) || quoted.length)) {
        if (!/^ {0,3}>/.test(lines[i]!) && (LIST_ITEM.test(lines[i]!) || ATX.test(lines[i]!) || HR.test(lines[i]!))) break;
        quoted.push(lines[i]!.replace(/^ {0,3}> ?/, ''));
        i++;
      }
      i--;
      blocks.push({ type: 'quote', blocks: parseBlocks(quoted) });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item && (!para.length || !/^\d/.test(item[2]!) || item[2]!.startsWith('1'))) {
      endPara();
      i = parseList(lines, i, blocks) - 1;
      continue;
    }
    if (!para.length && line.includes('|') && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]!).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : /^:/.test(c) ? 'left' : null));
      const rows = [header];
      i += 2;
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes('|')) rows.push(splitRow(lines[i++]!));
      i--;
      blocks.push({ type: 'table', rows, align });
      continue;
    }
    if (!para.length && /^ {4}/.test(line)) {
      const code: string[] = [];
      while (i < lines.length && (/^ {4}/.test(lines[i]!) || !lines[i]!.trim())) code.push(lines[i++]!.slice(4));
      i--;
      while (code.length && !code[code.length - 1]!.trim()) code.pop();
      blocks.push({ type: 'code', lines: code });
      continue;
    }
    para.push(line.trim());
  }
  endPara();
  return blocks;
}

/** Parses the list starting at line `start`; returns the index of the first line after it. */
function parseList(lines: string[], start: number, out: MdBlock[]): number {
  const first = LIST_ITEM.exec(lines[start]!)!;
  const ordered = /\d/.test(first[2]!);
  const delimiter = first[2]!.slice(-1);
  const list: Extract<MdBlock, { type: 'list' }> = { type: 'list', ordered, start: ordered ? parseInt(first[2]!, 10) : 1, items: [] };
  let i = start;
  while (i < lines.length) {
    const m = LIST_ITEM.exec(lines[i]!);
    if (!m || /\d/.test(m[2]!) !== ordered || m[2]!.slice(-1) !== delimiter) break;
    const contentIndent = m[1]!.length + m[2]!.length + Math.min(m[3]!.length || 1, 4);
    const itemLines = [lines[i]!.slice(contentIndent)];
    i++;
    let blank = false;
    while (i < lines.length) {
      const line = lines[i]!;
      if (!line.trim()) {
        blank = true;
        itemLines.push('');
        i++;
        continue;
      }
      const indent = /^ */.exec(line)![0].length;
      if (indent >= contentIndent) {
        itemLines.push(line.slice(contentIndent));
        blank = false;
        i++;
        continue;
      }
      // A lazy continuation line of the item's paragraph.
      if (!blank && !LIST_ITEM.test(line) && !ATX.test(line) && !HR.test(line) && !FENCE.test(line) && !/^ {0,3}>/.test(line)) {
        itemLines.push(line.trim());
        i++;
        continue;
      }
      break;
    }
    while (itemLines.length && !itemLines[itemLines.length - 1]!.trim()) itemLines.pop();
    let checked: boolean | undefined;
    const task = /^\[([ xX])\](?:\s+|$)/.exec(itemLines[0] ?? '');
    if (task) {
      checked = task[1] !== ' ';
      itemLines[0] = itemLines[0]!.slice(task[0].length);
    }
    list.items.push({ blocks: parseBlocks(itemLines), ...(checked === undefined ? {} : { checked }) });
    if (blank && i < lines.length && !LIST_ITEM.test(lines[i]!)) break;
  }
  out.push(list);
  return i;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

// ---------------------------------------------------------------- emitting

interface EmitCtx {
  lists: Record<string, ListDef>;
  makeId: () => string;
}

function emitBlocks(
  blocks: MdBlock[],
  builder: ContentBuilder,
  ctx: EmitCtx,
  para: ParaProps,
  list: { id: string; level: number } | null,
): void {
  let firstInItem = !!list;
  for (const b of blocks) {
    // The first paragraph of a list item is the item; later ones are indented continuations.
    const props: ParaProps = { ...para };
    if (list && firstInItem && (b.type === 'paragraph' || b.type === 'heading')) props.list = { ...list };
    else if (list) props.indentLeft = 36 * (list.level + 1);
    switch (b.type) {
      case 'heading':
        emitInline(b.text, builder, {}, ctx.makeId);
        builder.endParagraph({ ...props, style: `heading${b.level}` });
        break;
      case 'paragraph': {
        // A paragraph that is only an image (or only a horizontal rule-ish break) stays a paragraph.
        emitInline(b.text, builder, {}, ctx.makeId);
        builder.endParagraph(props);
        break;
      }
      case 'code':
        for (const line of b.lines.length ? b.lines : ['']) {
          builder.addText(cleanStoryText(line.replace(/ {4}/g, TAB)));
          builder.endParagraph({ ...props, style: 'code' });
        }
        break;
      case 'quote':
        emitBlocks(b.blocks, builder, ctx, { ...props, style: 'quote' }, null);
        break;
      case 'hr':
        builder.addObject({ kind: 'hr' });
        builder.endParagraph(props);
        break;
      case 'list': {
        const level = list ? Math.min(8, list.level + 1) : 0;
        const checklist = b.items.some((i) => i.checked !== undefined);
        let id = list?.id;
        if (!id) {
          id = ctx.makeId();
          ctx.lists[id] = checklist ? checkList() : b.ordered ? numberedList() : bulletList();
        }
        const def = ctx.lists[id]!;
        const lvl = def.levels[level]!;
        if (checklist) Object.assign(lvl, { format: 'check', text: '☐' });
        else if (b.ordered && (lvl.format === 'bullet' || lvl.format === 'check')) Object.assign(lvl, { format: 'decimal', text: `%${level + 1}.` });
        else if (!b.ordered && lvl.format !== 'bullet') Object.assign(lvl, { format: 'bullet', text: ['●', '○', '■'][level % 3]! });
        if (b.ordered && b.start !== 1) lvl.start = b.start;
        for (const item of b.items) {
          const itemPara: ParaProps = { ...para };
          if (item.checked !== undefined) itemPara.checked = item.checked;
          if (!item.blocks.length) {
            builder.endParagraph({ ...itemPara, list: { id, level } });
            continue;
          }
          emitBlocks(item.blocks, builder, ctx, itemPara, { id, level });
        }
        break;
      }
      case 'table': {
        const width = Math.max(...b.rows.map((r) => r.length));
        const rows: TableCellInput[][] = b.rows.map((row, ri) =>
          Array.from({ length: width }, (_, ci) => {
            const cell = new ContentBuilder(ctx.makeId);
            emitInline(row[ci] ?? '', cell, ri === 0 ? { bold: true } : {}, ctx.makeId);
            const align = b.align[ci];
            cell.endParagraph(align === 'center' || align === 'right' ? { align } : {});
            return { content: cell.build() };
          }),
        );
        builder.addTable(rows, { headerRows: b.rows.length > 1 ? 1 : 0 });
        builder.endParagraph(props);
        break;
      }
    }
    if (b.type !== 'list') firstInItem = false;
  }
}

// ---------------------------------------------------------------- inlines

type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'break' }
  | { type: 'image'; alt: string; src: string }
  | { type: 'style'; style: TextStyle; children: InlineNode[] };

interface Delim {
  char: string;
  length: number;
  canOpen: boolean;
  canClose: boolean;
  /** Index of its text node in the token list. */
  index: number;
}

function emitInline(source: string, builder: ContentBuilder, base: TextStyle, makeId: () => string): void {
  const write = (nodes: InlineNode[], style: TextStyle) => {
    for (const n of nodes) {
      if (n.type === 'text') builder.addText(cleanStoryText(n.text.replace(/\n/g, ' ')), style);
      else if (n.type === 'code') builder.addText(cleanStoryText(n.text), { ...style, font: 'Courier New' });
      else if (n.type === 'break') builder.addText(LINE_BREAK, style);
      else if (n.type === 'image') builder.addObject({ kind: 'image', id: makeId(), src: n.src, width: 300, height: 200, ...(n.alt ? { alt: n.alt } : {}) }, style);
      else write(n.children, { ...style, ...n.style });
    }
  };
  write(parseInline(source), base);
}

const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

export function parseInline(src: string): InlineNode[] {
  const tokens: InlineNode[] = [];
  const delims: Delim[] = [];
  let text = '';
  const pushText = () => {
    if (text) tokens.push({ type: 'text', text });
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '\\' && i + 1 < src.length) {
      if (src[i + 1] === '\n') {
        pushText();
        tokens.push({ type: 'break' });
        i += 2;
        continue;
      }
      if (ESCAPABLE.test(src[i + 1]!)) {
        text += src[i + 1];
        i += 2;
        continue;
      }
    }
    if (ch === '\n') {
      if (/ {2,}$/.test(text)) {
        text = text.replace(/ +$/, '');
        pushText();
        tokens.push({ type: 'break' });
      } else {
        text = text.replace(/ +$/, '') + '\n';
      }
      i++;
      continue;
    }
    if (ch === '`') {
      const run = /^`+/.exec(src.slice(i))![0];
      const close = src.indexOf(run, i + run.length);
      if (close >= 0 && src[close + run.length] !== '`') {
        pushText();
        let code = src.slice(i + run.length, close).replace(/\n/g, ' ');
        if (/^ .* $/.test(code) && code.trim()) code = code.slice(1, -1);
        tokens.push({ type: 'code', text: code });
        i = close + run.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }
    if (ch === '<') {
      const auto = /^<((?:https?|mailto):[^\s<>]+)>/i.exec(src.slice(i));
      if (auto) {
        pushText();
        tokens.push({ type: 'style', style: { link: auto[1] }, children: [{ type: 'text', text: auto[1]!.replace(/^mailto:/i, '') }] });
        i += auto[0].length;
        continue;
      }
    }
    if (ch === '!' && src[i + 1] === '[') {
      const link = readLink(src, i + 1);
      if (link) {
        pushText();
        tokens.push({ type: 'image', alt: link.label, src: link.url });
        i = link.end;
        continue;
      }
    }
    if (ch === '[') {
      const link = readLink(src, i);
      if (link) {
        pushText();
        tokens.push({ type: 'style', style: isSafeLink(link.url) ? { link: link.url } : {}, children: parseInline(link.label) });
        i = link.end;
        continue;
      }
    }
    if (ch === 'h' || ch === 'w') {
      const bare = /^(?:https?:\/\/|www\.)[^\s<]*[^\s<?!.,:*_~)]/.exec(src.slice(i));
      if (bare && (i === 0 || /[\s(*_~]/.test(src[i - 1]!))) {
        pushText();
        const url = bare[0].startsWith('www.') ? `http://${bare[0]}` : bare[0];
        tokens.push({ type: 'style', style: { link: url }, children: [{ type: 'text', text: bare[0] }] });
        i += bare[0].length;
        continue;
      }
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      const run = new RegExp(`^\\${ch}+`).exec(src.slice(i))![0];
      if (ch === '~' && run.length !== 2) {
        text += run;
        i += run.length;
        continue;
      }
      const before = i === 0 ? ' ' : src[i - 1]!;
      const after = src[i + run.length] ?? ' ';
      const wsAfter = /\s/.test(after);
      const wsBefore = /\s/.test(before);
      const punctAfter = /[\p{P}\p{S}]/u.test(after);
      const punctBefore = /[\p{P}\p{S}]/u.test(before);
      const leftFlanking = !wsAfter && (!punctAfter || wsBefore || punctBefore);
      const rightFlanking = !wsBefore && (!punctBefore || wsAfter || punctAfter);
      const canOpen = ch === '_' ? leftFlanking && (!rightFlanking || punctBefore) : leftFlanking;
      const canClose = ch === '_' ? rightFlanking && (!leftFlanking || punctAfter) : rightFlanking;
      pushText();
      tokens.push({ type: 'text', text: run });
      delims.push({ char: ch, length: run.length, canOpen, canClose, index: tokens.length - 1 });
      i += run.length;
      continue;
    }
    text += ch;
    i++;
  }
  pushText();
  return resolveEmphasis(tokens, delims);
}

/** Matches delimiter runs into emphasis, strong and strikethrough (CommonMark's algorithm, simplified). */
function resolveEmphasis(tokens: InlineNode[], delims: Delim[]): InlineNode[] {
  // Work on a linked list of tokens with delimiter info attached.
  type Node = { token: InlineNode; delim?: Delim; removed?: boolean };
  const nodes: Node[] = tokens.map((token, i) => ({ token, delim: delims.find((d) => d.index === i) }));
  for (let c = 0; c < nodes.length; c++) {
    const closer = nodes[c]!;
    if (!closer.delim?.canClose || closer.removed) continue;
    while (closer.delim.length > 0) {
      let o = c - 1;
      for (; o >= 0; o--) {
        const d = nodes[o]!.delim;
        if (!nodes[o]!.removed && d && d.char === closer.delim.char && d.canOpen && d.length > 0) {
          if (d.char === '~' && d.length !== closer.delim.length) continue;
          break;
        }
      }
      if (o < 0) break;
      const opener = nodes[o]!;
      const use = closer.delim.char === '~' ? 2 : opener.delim!.length >= 2 && closer.delim.length >= 2 ? 2 : 1;
      const style: TextStyle = closer.delim.char === '~' ? { strike: true } : use === 2 ? { bold: true } : { italic: true };
      const inner = nodes.slice(o + 1, c).filter((n) => !n.removed);
      for (let k = o + 1; k < c; k++) nodes[k]!.removed = true;
      opener.delim!.length -= use;
      closer.delim.length -= use;
      (opener.token as { text: string }).text = closer.delim.char.repeat(opener.delim!.length);
      (closer.token as { text: string }).text = closer.delim.char.repeat(closer.delim.length);
      // The wrapped run lives on in a new node right after the opener.
      nodes.splice(o + 1, 0, { token: { type: 'style', style, children: inner.map((n) => n.token) } });
      c++;
    }
  }
  return merge(nodes.filter((n) => !n.removed).map((n) => n.token));
}

function merge(tokens: InlineNode[]): InlineNode[] {
  const out: InlineNode[] = [];
  for (const t of tokens) {
    if (t.type === 'text' && !t.text) continue;
    const last = out[out.length - 1];
    if (t.type === 'text' && last?.type === 'text') last.text += t.text;
    else out.push(t);
  }
  return out;
}

function readLink(src: string, start: number): { label: string; url: string; end: number } | null {
  // [label](url "title") with balanced brackets in the label.
  let depth = 0;
  let i = start;
  for (; i < src.length; i++) {
    if (src[i] === '\\') {
      i++;
      continue;
    }
    if (src[i] === '[') depth++;
    else if (src[i] === ']' && --depth === 0) break;
  }
  if (i >= src.length || src[i + 1] !== '(') return null;
  const label = src.slice(start + 1, i);
  const rest = /^\(\s*(<[^>]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+("[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/.exec(src.slice(i + 1));
  if (!rest) return null;
  const url = rest[1]!.replace(/^<|>$/g, '');
  return { label, url, end: i + 1 + rest[0].length };
}
