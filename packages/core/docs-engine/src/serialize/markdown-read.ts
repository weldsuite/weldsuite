/**
 * Markdown in: CommonMark's blocks and inlines plus GitHub's tables, task
 * lists, strikethrough and bare links. Raw HTML is kept as text.
 *
 * The block and link syntax is scanned by hand rather than with one big
 * regular expression each, so a hostile paste (a long run of spaces, `#`s or
 * brackets) costs linear time instead of backtracking.
 */

import { cleanStoryText, LINE_BREAK, TAB } from '../model/chars';
import { ContentBuilder, type Fragment, type TableCellInput } from '../model/builder';
import { bulletList, checkList, numberedList } from '../model/defaults';
import { newId } from '../model/ids';
import { isSafeLink, type ListDef, type ListLevel, type ParaProps, type TextStyle } from '../model/styles';

export interface MarkdownReadOptions {
  makeId?: () => string;
}

type MdBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; lines: string[] }
  | { type: 'quote'; blocks: MdBlock[] }
  | { type: 'hr' }
  | { type: 'list'; ordered: boolean; start: number; items: MdListItem[] }
  | { type: 'table'; rows: string[][]; align: (string | null)[] };

type MdListItem = { blocks: MdBlock[]; checked?: boolean };
type MdList = Extract<MdBlock, { type: 'list' }>;
type MdTable = Extract<MdBlock, { type: 'table' }>;

export function fromMarkdown(markdown: string, options: MarkdownReadOptions = {}): Fragment {
  const makeId = options.makeId ?? newId;
  const blocks = parseBlocks(markdown.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
  const lists: Record<string, ListDef> = {};
  const builder = new ContentBuilder(makeId);
  emitBlocks(blocks, builder, { lists, makeId }, {}, null);
  const content = builder.build();
  return Object.keys(lists).length ? { content, lists } : { content };
}

// ---------------------------------------------------------------- line syntax

const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_ITEM = /^( {0,3})([-+*]|\d{1,9}[.)])( +|$)/;
const QUOTE = /^ {0,3}>/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)\s*$/;
const DELIMITER_CELL = /^:?-+:?$/;
/** What a regex `.` does not match; an ATX heading cannot hold one. */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

function leadingSpaces(line: string): number {
  let n = 0;
  while (line[n] === ' ') n++;
  return n;
}

function isSpaceOrTab(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t';
}

/** `text` without spaces and tabs at either end. */
function trimSpaceTab(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isSpaceOrTab(text[start])) start++;
  while (end > start && isSpaceOrTab(text[end - 1])) end--;
  return text.slice(start, end);
}

/**
 * The opening run of a fenced code block (three or more backticks or tildes,
 * indented at most three spaces), or null. The rest of the line may not hold
 * a backtick, for either kind of fence.
 */
function fenceMarker(line: string): string | null {
  const indent = leadingSpaces(line);
  const ch = line[indent];
  if (indent > 3 || (ch !== '`' && ch !== '~')) return null;
  let end = indent;
  while (line[end] === ch) end++;
  if (end - indent < 3 || line.includes('`', end)) return null;
  return line.slice(indent, end);
}

/** True when `line` closes a fence opened with `marker`: at least as long a run of the same character, then only whitespace. */
function closesFence(line: string, marker: string): boolean {
  const indent = leadingSpaces(line);
  if (indent > 3) return false;
  let end = indent;
  while (line[end] === marker[0]) end++;
  return end - indent >= marker.length && !line.slice(end).trim();
}

/**
 * An ATX heading (`## Title ##`): its level and text, or null. The closing
 * run of `#`s is dropped only when whitespace separates it from the text.
 */
function parseAtx(line: string): { level: number; text: string } | null {
  const indent = leadingSpaces(line);
  if (indent > 3) return null;
  let end = indent;
  while (line[end] === '#') end++;
  const level = end - indent;
  if (level < 1 || level > 6) return null;
  const rest = line.slice(end);
  if (!rest) return { level, text: '' };
  if (!isSpaceOrTab(rest[0]) || LINE_TERMINATOR.test(rest)) return null;
  return { level, text: atxText(trimSpaceTab(rest)) };
}

/** A trimmed ATX heading body without its closing `#` sequence. */
function atxText(body: string): string {
  let hashes = body.length;
  while (hashes > 0 && body[hashes - 1] === '#') hashes--;
  if (hashes === body.length || !isSpaceOrTab(body[hashes - 1])) return body;
  let end = hashes;
  while (end > 0 && isSpaceOrTab(body[end - 1])) end--;
  return body.slice(0, end);
}

/** A table's delimiter row (`| --- | :-: |`): cells of dashes with optional alignment colons. */
function isTableDelimiter(line: string): boolean {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  return row.split('|').every((cell) => DELIMITER_CELL.test(cell.trim()));
}

/** A column's alignment from its delimiter cell. */
function cellAlign(cell: string): 'center' | 'right' | 'left' | null {
  if (/^:-+:$/.test(cell)) return 'center';
  if (cell.endsWith('-:')) return 'right';
  if (cell.startsWith(':')) return 'left';
  return null;
}

// ---------------------------------------------------------------- blocks

interface BlockState {
  lines: string[];
  blocks: MdBlock[];
  /** Lines of the paragraph being collected. */
  para: string[];
}

function parseBlocks(lines: string[]): MdBlock[] {
  const state: BlockState = { lines, blocks: [], para: [] };
  let i = 0;
  while (i < lines.length) i = parseLine(state, i);
  endPara(state);
  return state.blocks;
}

function endPara(state: BlockState): void {
  if (state.para.length) state.blocks.push({ type: 'paragraph', text: state.para.join('\n') });
  state.para = [];
}

/**
 * Reads the block that starts at line `i` (or adds the line to the paragraph
 * being collected); returns the index of the next line to read. The block
 * kinds are tried in order, each returning null when the line is not one.
 */
function parseLine(state: BlockState, i: number): number {
  if (!state.lines[i]!.trim()) {
    endPara(state);
    return i + 1;
  }
  return (
    parseFence(state, i) ??
    parseSetext(state, i) ??
    parseAtxHeading(state, i) ??
    parseHr(state, i) ??
    parseQuote(state, i) ??
    parseListStart(state, i) ??
    parseTable(state, i) ??
    parseIndentedCode(state, i) ??
    addParagraphLine(state, i)
  );
}

function parseFence(state: BlockState, i: number): number | null {
  const { lines } = state;
  const marker = fenceMarker(lines[i]!);
  if (!marker) return null;
  endPara(state);
  const code: string[] = [];
  let j = i + 1;
  while (j < lines.length && !closesFence(lines[j]!, marker)) code.push(lines[j++]!);
  state.blocks.push({ type: 'code', lines: code });
  // Past the closing fence (or the end, when there is none).
  return j + 1;
}

/** A setext heading underlines the paragraph just collected. */
function parseSetext(state: BlockState, i: number): number | null {
  const line = state.lines[i]!;
  if (!state.para.length || !SETEXT_UNDERLINE.test(line)) return null;
  state.blocks.push({ type: 'heading', level: line.trim()[0] === '=' ? 1 : 2, text: state.para.join('\n') });
  state.para = [];
  return i + 1;
}

function parseAtxHeading(state: BlockState, i: number): number | null {
  const atx = parseAtx(state.lines[i]!);
  if (!atx) return null;
  endPara(state);
  state.blocks.push({ type: 'heading', level: atx.level, text: atx.text });
  return i + 1;
}

function parseHr(state: BlockState, i: number): number | null {
  if (!HR.test(state.lines[i]!)) return null;
  endPara(state);
  state.blocks.push({ type: 'hr' });
  return i + 1;
}

function parseQuote(state: BlockState, i: number): number | null {
  const { lines } = state;
  if (!QUOTE.test(lines[i]!)) return null;
  endPara(state);
  const quoted: string[] = [];
  let j = i;
  while (j < lines.length && continuesQuote(lines[j]!, quoted.length > 0)) {
    quoted.push(lines[j]!.replace(/^ {0,3}> ?/, ''));
    j++;
  }
  state.blocks.push({ type: 'quote', blocks: parseBlocks(quoted) });
  return j;
}

/** Whether `line` belongs to the block quote: a `>` line, or a lazy continuation once the quote has started. */
function continuesQuote(line: string, started: boolean): boolean {
  if (!line.trim()) return false;
  if (QUOTE.test(line)) return true;
  return started && !LIST_ITEM.test(line) && !parseAtx(line) && !HR.test(line);
}

/** A list; one numbered from other than 1 cannot interrupt a paragraph. */
function parseListStart(state: BlockState, i: number): number | null {
  const item = LIST_ITEM.exec(state.lines[i]!);
  if (!item) return null;
  const marker = item[2]!;
  if (state.para.length && /^\d/.test(marker) && !marker.startsWith('1')) return null;
  endPara(state);
  return parseList(state.lines, i, state.blocks);
}

function parseTable(state: BlockState, i: number): number | null {
  const { lines } = state;
  const line = lines[i]!;
  const delimiter = lines[i + 1];
  if (state.para.length || !line.includes('|') || delimiter === undefined) return null;
  if (!isTableDelimiter(delimiter) || !delimiter.includes('-')) return null;
  const rows = [splitRow(line)];
  const align = splitRow(delimiter).map(cellAlign);
  let j = i + 2;
  while (j < lines.length && lines[j]!.trim() && lines[j]!.includes('|')) rows.push(splitRow(lines[j++]!));
  state.blocks.push({ type: 'table', rows, align });
  return j;
}

function parseIndentedCode(state: BlockState, i: number): number | null {
  const { lines } = state;
  if (state.para.length || !lines[i]!.startsWith('    ')) return null;
  const code: string[] = [];
  let j = i;
  while (j < lines.length && (lines[j]!.startsWith('    ') || !lines[j]!.trim())) code.push(lines[j++]!.slice(4));
  while (code.length && !code[code.length - 1]!.trim()) code.pop();
  state.blocks.push({ type: 'code', lines: code });
  return j;
}

function addParagraphLine(state: BlockState, i: number): number {
  state.para.push(state.lines[i]!.trim());
  return i + 1;
}

/** Parses the list starting at line `start`; returns the index of the first line after it. */
function parseList(lines: string[], start: number, out: MdBlock[]): number {
  const first = LIST_ITEM.exec(lines[start]!)!;
  const ordered = /\d/.test(first[2]!);
  const delimiter = first[2]!.slice(-1);
  const list: MdList = { type: 'list', ordered, start: ordered ? parseInt(first[2]!, 10) : 1, items: [] };
  let i = start;
  while (i < lines.length) {
    const m = LIST_ITEM.exec(lines[i]!);
    if (!m || /\d/.test(m[2]!) !== ordered || m[2]!.slice(-1) !== delimiter) break;
    const read = readListItem(lines, i, m);
    list.items.push(read.item);
    i = read.next;
    if (read.blank && i < lines.length && !LIST_ITEM.test(lines[i]!)) break;
  }
  out.push(list);
  return i;
}

/**
 * Reads the list item whose marker (matched as `m`) is on line `start`.
 * Returns the item, the index of the line after it, and whether it ended in
 * a blank line (which ends the list unless another item follows).
 */
function readListItem(lines: string[], start: number, m: RegExpExecArray): { item: MdListItem; next: number; blank: boolean } {
  const contentIndent = m[1]!.length + m[2]!.length + Math.min(m[3]!.length || 1, 4);
  const itemLines = [lines[start]!.slice(contentIndent)];
  let i = start + 1;
  let blank = false;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      blank = true;
      itemLines.push('');
    } else if (leadingSpaces(line) >= contentIndent) {
      itemLines.push(line.slice(contentIndent));
      blank = false;
    } else if (!blank && isLazyContinuation(line)) {
      itemLines.push(line.trim());
    } else {
      break;
    }
    i++;
  }
  while (itemLines.length && !itemLines[itemLines.length - 1]!.trim()) itemLines.pop();
  const checked = takeTaskBox(itemLines);
  const item: MdListItem = { blocks: parseBlocks(itemLines), ...(checked === undefined ? {} : { checked }) };
  return { item, next: i, blank };
}

/** A line that continues an item's paragraph without being indented: one that starts no other block. */
function isLazyContinuation(line: string): boolean {
  return !LIST_ITEM.test(line) && !parseAtx(line) && !HR.test(line) && !fenceMarker(line) && !QUOTE.test(line);
}

/** Strips a task box (`[ ]` or `[x]`) off an item's first line; returns whether it is ticked, or undefined when there is none. */
function takeTaskBox(itemLines: string[]): boolean | undefined {
  const task = /^\[([ xX])\](?:\s+|$)/.exec(itemLines[0] ?? '');
  if (!task) return undefined;
  itemLines[0] = itemLines[0]!.slice(task[0].length);
  return task[1] !== ' ';
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

type ListRef = { id: string; level: number };

function emitBlocks(blocks: MdBlock[], builder: ContentBuilder, ctx: EmitCtx, para: ParaProps, list: ListRef | null): void {
  let firstInItem = !!list;
  for (const b of blocks) {
    emitBlock(b, builder, ctx, blockProps(b, para, list, firstInItem), para, list);
    if (b.type !== 'list') firstInItem = false;
  }
}

/** The first paragraph of a list item is the item; later ones are indented continuations. */
function blockProps(b: MdBlock, para: ParaProps, list: ListRef | null, firstInItem: boolean): ParaProps {
  const props: ParaProps = { ...para };
  if (list && firstInItem && (b.type === 'paragraph' || b.type === 'heading')) props.list = { ...list };
  else if (list) props.indentLeft = 36 * (list.level + 1);
  return props;
}

function emitBlock(b: MdBlock, builder: ContentBuilder, ctx: EmitCtx, props: ParaProps, para: ParaProps, list: ListRef | null): void {
  switch (b.type) {
    case 'heading':
      emitInline(b.text, builder, {}, ctx.makeId);
      builder.endParagraph({ ...props, style: `heading${b.level}` });
      break;
    case 'paragraph':
      // A paragraph that is only an image (or only a horizontal rule-ish break) stays a paragraph.
      emitInline(b.text, builder, {}, ctx.makeId);
      builder.endParagraph(props);
      break;
    case 'code':
      emitCode(b.lines, builder, props);
      break;
    case 'quote':
      emitBlocks(b.blocks, builder, ctx, { ...props, style: 'quote' }, null);
      break;
    case 'hr':
      builder.addObject({ kind: 'hr' });
      builder.endParagraph(props);
      break;
    case 'list':
      emitList(b, builder, ctx, para, list);
      break;
    case 'table':
      emitTable(b, builder, ctx, props);
      break;
  }
}

function emitCode(lines: string[], builder: ContentBuilder, props: ParaProps): void {
  for (const line of lines.length ? lines : ['']) {
    builder.addText(cleanStoryText(line.replace(/ {4}/g, TAB)));
    builder.endParagraph({ ...props, style: 'code' });
  }
}

/** A nested list continues its parent's definition one level down; a top-level one gets a new definition. */
function emitList(b: MdList, builder: ContentBuilder, ctx: EmitCtx, para: ParaProps, list: ListRef | null): void {
  const level = list ? Math.min(8, list.level + 1) : 0;
  const checklist = b.items.some((i) => i.checked !== undefined);
  let id = list?.id;
  if (!id) {
    id = ctx.makeId();
    ctx.lists[id] = newListDef(checklist, b.ordered);
  }
  formatLevel(ctx.lists[id]!.levels[level]!, level, checklist, b);
  for (const item of b.items) {
    const itemPara: ParaProps = { ...para };
    if (item.checked !== undefined) itemPara.checked = item.checked;
    if (item.blocks.length) emitBlocks(item.blocks, builder, ctx, itemPara, { id, level });
    else builder.endParagraph({ ...itemPara, list: { id, level } });
  }
}

function newListDef(checklist: boolean, ordered: boolean): ListDef {
  if (checklist) return checkList();
  return ordered ? numberedList() : bulletList();
}

/** Makes a list level number (or bullet, or tick) the way this Markdown list does. */
function formatLevel(lvl: ListLevel, level: number, checklist: boolean, b: MdList): void {
  if (checklist) Object.assign(lvl, { format: 'check', text: '☐' });
  else if (b.ordered && (lvl.format === 'bullet' || lvl.format === 'check')) Object.assign(lvl, { format: 'decimal', text: `%${level + 1}.` });
  else if (!b.ordered && lvl.format !== 'bullet') Object.assign(lvl, { format: 'bullet', text: ['●', '○', '■'][level % 3]! });
  if (b.ordered && b.start !== 1) lvl.start = b.start;
}

function emitTable(b: MdTable, builder: ContentBuilder, ctx: EmitCtx, props: ParaProps): void {
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
  const scanner = new InlineScanner(src);
  while (!scanner.done) scanner.step();
  return scanner.finish();
}

/** How many times the character at `at` repeats from there. */
function runLength(src: string, at: number): number {
  let end = at;
  while (src[end] === src[at]) end++;
  return end - at;
}

/** `text` without trailing spaces. */
function trimTrailingSpaces(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === ' ') end--;
  return text.slice(0, end);
}

/**
 * Tokenises one run of inline Markdown: plain text, code spans, links,
 * images and line breaks, plus the delimiter runs that `resolveEmphasis`
 * later pairs into emphasis.
 */
class InlineScanner {
  private readonly tokens: InlineNode[] = [];
  private readonly delims: Delim[] = [];
  /** Plain text not yet pushed as a token. */
  private text = '';
  private i = 0;

  constructor(private readonly src: string) {}

  get done(): boolean {
    return this.i >= this.src.length;
  }

  /** Reads the construct at the cursor, or else one plain character. */
  step(): void {
    if (this.escape() || this.lineEnd() || this.codeSpan() || this.autolink() || this.image() || this.link() || this.bareLink() || this.delimiterRun()) return;
    this.text += this.src[this.i];
    this.i++;
  }

  finish(): InlineNode[] {
    this.pushText();
    return resolveEmphasis(this.tokens, this.delims);
  }

  private pushText(): void {
    if (this.text) this.tokens.push({ type: 'text', text: this.text });
    this.text = '';
  }

  /** A backslash before a line end is a hard break; before punctuation, it makes it literal. */
  private escape(): boolean {
    const { src, i } = this;
    if (src[i] !== '\\' || i + 1 >= src.length) return false;
    const next = src[i + 1]!;
    if (next === '\n') {
      this.pushText();
      this.tokens.push({ type: 'break' });
    } else if (ESCAPABLE.test(next)) {
      this.text += next;
    } else {
      return false;
    }
    this.i += 2;
    return true;
  }

  /** A line end is a hard break after two or more spaces, else a soft one; trailing spaces go either way. */
  private lineEnd(): boolean {
    if (this.src[this.i] !== '\n') return false;
    const trimmed = trimTrailingSpaces(this.text);
    if (this.text.length - trimmed.length >= 2) {
      this.text = trimmed;
      this.pushText();
      this.tokens.push({ type: 'break' });
    } else {
      this.text = trimmed + '\n';
    }
    this.i++;
    return true;
  }

  /** A code span closes at the next backtick run of the same length; without one, the run is literal. */
  private codeSpan(): boolean {
    const { src, i } = this;
    if (src[i] !== '`') return false;
    const run = src.slice(i, i + runLength(src, i));
    const close = src.indexOf(run, i + run.length);
    if (close < 0 || src[close + run.length] === '`') {
      this.text += run;
      this.i += run.length;
      return true;
    }
    this.pushText();
    let code = src.slice(i + run.length, close).replace(/\n/g, ' ');
    if (/^ .* $/.test(code) && code.trim()) code = code.slice(1, -1);
    this.tokens.push({ type: 'code', text: code });
    this.i = close + run.length;
    return true;
  }

  private autolink(): boolean {
    if (this.src[this.i] !== '<') return false;
    const auto = /^<((?:https?|mailto):[^\s<>]+)>/i.exec(this.src.slice(this.i));
    if (!auto) return false;
    this.pushText();
    this.tokens.push({ type: 'style', style: { link: auto[1] }, children: [{ type: 'text', text: auto[1]!.replace(/^mailto:/i, '') }] });
    this.i += auto[0].length;
    return true;
  }

  private image(): boolean {
    if (this.src[this.i] !== '!' || this.src[this.i + 1] !== '[') return false;
    const link = readLink(this.src, this.i + 1);
    if (!link) return false;
    this.pushText();
    this.tokens.push({ type: 'image', alt: link.label, src: link.url });
    this.i = link.end;
    return true;
  }

  private link(): boolean {
    if (this.src[this.i] !== '[') return false;
    const link = readLink(this.src, this.i);
    if (!link) return false;
    this.pushText();
    this.tokens.push({ type: 'style', style: isSafeLink(link.url) ? { link: link.url } : {}, children: parseInline(link.label) });
    this.i = link.end;
    return true;
  }

  /** GitHub's bare `https://…` and `www.…` links, at the start or after a space, bracket or delimiter. */
  private bareLink(): boolean {
    const { src, i } = this;
    if (src[i] !== 'h' && src[i] !== 'w') return false;
    const bare = /^(?:https?:\/\/|www\.)[^\s<]*[^\s<?!.,:*_~)]/.exec(src.slice(i));
    if (!bare || (i > 0 && !/[\s(*_~]/.test(src[i - 1]!))) return false;
    this.pushText();
    const url = bare[0].startsWith('www.') ? `http://${bare[0]}` : bare[0];
    this.tokens.push({ type: 'style', style: { link: url }, children: [{ type: 'text', text: bare[0] }] });
    this.i += bare[0].length;
    return true;
  }

  /** A run of `*`, `_` or `~~`, kept as text and noted as a delimiter that may become emphasis. */
  private delimiterRun(): boolean {
    const { src, i } = this;
    const ch = src[i]!;
    if (ch !== '*' && ch !== '_' && ch !== '~') return false;
    const length = runLength(src, i);
    const run = src.slice(i, i + length);
    this.i += length;
    if (ch === '~' && length !== 2) {
      this.text += run;
      return true;
    }
    const { canOpen, canClose } = flanking(ch, i === 0 ? ' ' : src[i - 1]!, src[i + length] ?? ' ');
    this.pushText();
    this.tokens.push({ type: 'text', text: run });
    this.delims.push({ char: ch, length, canOpen, canClose, index: this.tokens.length - 1 });
    return true;
  }
}

/** Whether a delimiter run of `ch` between `before` and `after` can open and close emphasis (CommonMark's flanking rules). */
function flanking(ch: string, before: string, after: string): { canOpen: boolean; canClose: boolean } {
  const wsAfter = /\s/.test(after);
  const wsBefore = /\s/.test(before);
  const punctAfter = /[\p{P}\p{S}]/u.test(after);
  const punctBefore = /[\p{P}\p{S}]/u.test(before);
  const leftFlanking = !wsAfter && (!punctAfter || wsBefore || punctBefore);
  const rightFlanking = !wsBefore && (!punctBefore || wsAfter || punctAfter);
  if (ch !== '_') return { canOpen: leftFlanking, canClose: rightFlanking };
  // An underscore inside a word does not emphasise.
  return { canOpen: leftFlanking && (!rightFlanking || punctBefore), canClose: rightFlanking && (!leftFlanking || punctAfter) };
}

/** A token with its delimiter info attached, while emphasis is being matched. */
interface EmphasisNode {
  token: InlineNode;
  delim?: Delim;
  removed?: boolean;
}

/** Matches delimiter runs into emphasis, strong and strikethrough (CommonMark's algorithm, simplified). */
function resolveEmphasis(tokens: InlineNode[], delims: Delim[]): InlineNode[] {
  const nodes: EmphasisNode[] = tokens.map((token, i) => ({ token, delim: delims.find((d) => d.index === i) }));
  let c = 0;
  while (c < nodes.length) c = closeEmphasis(nodes, c) + 1;
  return merge(nodes.filter((n) => !n.removed).map((n) => n.token));
}

/**
 * Uses node `at` as a closer against the nearest matching openers before it,
 * as often as its delimiters last. Each match inserts a node before the
 * closer, so this returns the closer's index afterwards.
 */
function closeEmphasis(nodes: EmphasisNode[], at: number): number {
  const closer = nodes[at]!;
  const delim = closer.delim;
  if (!delim?.canClose || closer.removed) return at;
  let c = at;
  while (delim.length > 0) {
    const o = findOpener(nodes, c, delim);
    if (o < 0) break;
    wrapEmphasis(nodes, o, c);
    c++;
  }
  return c;
}

/** The nearest node before `c` that can open emphasis for `closer` (strikethrough runs must be equally long), or -1. */
function findOpener(nodes: EmphasisNode[], c: number, closer: Delim): number {
  for (let o = c - 1; o >= 0; o--) {
    const d = nodes[o]!.delim;
    if (nodes[o]!.removed || !d || d.char !== closer.char || !d.canOpen || d.length <= 0) continue;
    if (d.char !== '~' || d.length === closer.length) return o;
  }
  return -1;
}

/** Wraps the nodes between opener `o` and closer `c` in a style node, using up delimiters on both sides. */
function wrapEmphasis(nodes: EmphasisNode[], o: number, c: number): void {
  const opener = nodes[o]!;
  const closer = nodes[c]!;
  const open = opener.delim!;
  const close = closer.delim!;
  const use = delimitersUsed(open, close);
  const style = emphasisStyle(close.char, use);
  const inner = nodes.slice(o + 1, c).filter((n) => !n.removed);
  for (let k = o + 1; k < c; k++) nodes[k]!.removed = true;
  open.length -= use;
  close.length -= use;
  (opener.token as { text: string }).text = close.char.repeat(open.length);
  (closer.token as { text: string }).text = close.char.repeat(close.length);
  // The wrapped run lives on in a new node right after the opener.
  nodes.splice(o + 1, 0, { token: { type: 'style', style, children: inner.map((n) => n.token) } });
}

/** Strikethrough uses two delimiters; otherwise strong (two) when both runs have them, else emphasis (one). */
function delimitersUsed(opener: Delim, closer: Delim): number {
  if (closer.char === '~') return 2;
  return opener.length >= 2 && closer.length >= 2 ? 2 : 1;
}

function emphasisStyle(char: string, use: number): TextStyle {
  if (char === '~') return { strike: true };
  return use === 2 ? { bold: true } : { italic: true };
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

// ---------------------------------------------------------------- links

/** `[label](url "title")` with balanced brackets in the label, the `[` at `start`. */
function readLink(src: string, start: number): { label: string; url: string; end: number } | null {
  const close = labelEnd(src, start);
  if (close < 0 || src[close + 1] !== '(') return null;
  const destination = readDestination(src, close + 1);
  if (!destination) return null;
  return { label: src.slice(start + 1, close), url: destination.url.replace(/^<|>$/g, ''), end: destination.end };
}

/** Index of the `]` closing the label whose `[` is at `start` (brackets balance; a backslash skips the next character), or -1. */
function labelEnd(src: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

const TITLE_CLOSE = new Map([
  ['"', '"'],
  ["'", "'"],
  ['(', ')'],
]);

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

function skipSpaces(src: string, at: number): number {
  let i = at;
  while (isSpace(src[i])) i++;
  return i;
}

/**
 * The destination in `(url "title")`, the `(` at `open`: the raw url and the
 * index after the closing `)`, or null. An `<…>` url is tried before a bare
 * one; with neither, the destination is empty and the spaces after `(`
 * separate the title.
 */
function readDestination(src: string, open: number): { url: string; end: number } | null {
  const start = skipSpaces(src, open + 1);
  const starts = start > open + 1 ? [start, start - 1] : [start];
  for (const from of starts) {
    for (const to of [angleUrlEnd(src, from), bareUrlEnd(src, from)]) {
      if (to < 0) continue;
      const end = titleAndCloseEnd(src, to);
      if (end >= 0) return { url: src.slice(from, to), end };
    }
  }
  return null;
}

/** End of an `<…>` url starting at `from`, or -1. */
function angleUrlEnd(src: string, from: number): number {
  if (src[from] !== '<') return -1;
  const close = src.indexOf('>', from + 1);
  return close < 0 ? -1 : close + 1;
}

/** End of a bare url starting at `from`: characters other than spaces and parentheses, plus one-deep `(…)` groups. */
function bareUrlEnd(src: string, from: number): number {
  let i = plainUrlEnd(src, from);
  while (src[i] === '(') {
    const inner = plainUrlEnd(src, i + 1);
    if (src[inner] !== ')') break;
    i = plainUrlEnd(src, inner + 1);
  }
  return i;
}

function plainUrlEnd(src: string, at: number): number {
  let i = at;
  while (i < src.length && src[i] !== '(' && src[i] !== ')' && !isSpace(src[i])) i++;
  return i;
}

/** After a url ending at `at`: an optional title, spaces and the closing `)`. Returns the index after the `)`, or -1. */
function titleAndCloseEnd(src: string, at: number): number {
  const title = titleEnd(src, at);
  const afterTitle = title < 0 ? -1 : closeParenEnd(src, title);
  return afterTitle >= 0 ? afterTitle : closeParenEnd(src, at);
}

/** End of a title (`"…"`, `'…'` or `(…)`) that follows spaces at `at`, or -1. */
function titleEnd(src: string, at: number): number {
  const open = skipSpaces(src, at);
  const close = open > at ? TITLE_CLOSE.get(src[open] ?? '') : undefined;
  if (!close) return -1;
  const end = src.indexOf(close, open + 1);
  return end < 0 ? -1 : end + 1;
}

function closeParenEnd(src: string, at: number): number {
  const i = skipSpaces(src, at);
  return src[i] === ')' ? i + 1 : -1;
}
