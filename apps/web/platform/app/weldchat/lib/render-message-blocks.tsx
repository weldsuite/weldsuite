/**
 * Block-level markdown for agent-authored WeldChat messages.
 *
 * Agents answer in markdown: paragraphs, `-` / `1.` lists (nested too), `#`
 * headings, fenced code, quotes and `|` tables. People write plain text in the composer, so
 * only agent messages go through this; `renderMessageContent` keeps rendering
 * everything *inside* a block (mention chips, record chips, links, **bold**,
 * `code`), so an agent message reads exactly like any other one, with lists.
 *
 * Output is built from React elements and strings only (never HTML), so message
 * text cannot inject markup. A message that is a single plain paragraph is
 * handed straight to `renderMessageContent`, so it renders as before.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import {
  MAX_EMPHASIS_CHARS,
  renderMessageContent,
  type InlineFileRenderer,
} from './render-message-content';

export type TableAlign = 'left' | 'center' | 'right' | null;

export type MessageBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: MessageBlock[][] }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; blocks: MessageBlock[] }
  | { kind: 'table'; header: string[]; align: TableAlign[]; rows: string[][] }
  | { kind: 'rule' };

/** Lists and quotes nest this deep; anything below is plain text. */
const MAX_DEPTH = 4;

/** A table wider or longer than this is cut there (the rest stays in the message text). */
const MAX_TABLE_COLUMNS = 20;
const MAX_TABLE_ROWS = 200;

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
/** The closing `#`s and surrounding space are trimmed by {@link headingText}. */
const HEADING = /^\s{0,3}(#{1,6})\s(.*)$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
/** indent · marker (`-`, `*`, `+`, `•`, `1.`, `1)`) · gap · text */
const ITEM = /^( *)([-*+•]|\d{1,4}[.)])( +)([^ ].*)?$/;

function expandTabs(line: string): string {
  return line.replace(/^\t+/, (tabs) => '    '.repeat(tabs.length));
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function matchItem(line: string): { indent: number; marker: string; gap: number; text: string } | null {
  const m = ITEM.exec(line);
  return m ? { indent: m[1].length, marker: m[2], gap: Math.min(m[3].length, 4), text: m[4] ?? '' } : null;
}

/** A heading's text without its optional closing run of `#`s ("# Title ##" → "Title"; "# C#" keeps its `#`). */
function headingText(raw: string): string {
  const text = raw.trim();
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end--;
  if (end < text.length && end > 0 && /\s/.test(text[end - 1])) return text.slice(0, end).trim();
  return text;
}

const isOrderedMarker = (marker: string): boolean => /\d/.test(marker);

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || matchItem(line) !== null;
}

function closesFence(line: string, opener: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= opener.length && trimmed === opener[0].repeat(trimmed.length);
}

type ListItem = NonNullable<ReturnType<typeof matchItem>>;

/** A block read from `lines` at some index, and the index after it. */
type BlockRead = { block: MessageBlock; next: number };

/**
 * Where an indented continuation resumes after the blank line at `start`, or
 * null when none follows (blank lines stay in an item only in that case).
 */
function continuationAfterBlanks(lines: string[], start: number, baseIndent: number): number | null {
  let k = start + 1;
  while (k < lines.length && lines[k].trim() === '') k++;
  return k < lines.length && indentOf(lines[k]) >= baseIndent + 2 ? k : null;
}

/** The lines that belong to the list item at `start`, and the index after them. */
function collectItemBody(lines: string[], start: number, baseIndent: number, item: ListItem): { body: string[]; next: number } {
  const contentIndent = item.indent + item.marker.length + item.gap;
  const body: string[] = [item.text];
  let j = start + 1;
  while (j < lines.length) {
    const line = lines[j];
    if (line.trim() === '') {
      const resume = continuationAfterBlanks(lines, j, baseIndent);
      if (resume === null) break;
      for (let b = j; b < resume; b++) body.push('');
      j = resume;
      continue;
    }
    const indent = indentOf(line);
    if (indent >= baseIndent + 2) body.push(line.slice(Math.min(contentIndent, indent)));
    // Lazy continuation: a wrapped line of the item's text.
    else if (!startsBlock(line) && lines[j - 1].trim() !== '') body.push(line.trim());
    else break;
    j++;
  }
  return { body, next: j };
}

/** A loose list (blank line between items) is still one list: the index of its next item, else `i`. */
function nextLooseItem(lines: string[], i: number, baseIndent: number, ordered: boolean): number {
  let k = i;
  while (k < lines.length && lines[k].trim() === '') k++;
  if (k === i || k >= lines.length) return i;
  const next = matchItem(lines[k]);
  return next && next.indent < baseIndent + 2 && isOrderedMarker(next.marker) === ordered ? k : i;
}

function parseList(lines: string[], start: number, depth: number): BlockRead {
  const first = matchItem(lines[start]) as ListItem;
  const baseIndent = first.indent;
  const ordered = isOrderedMarker(first.marker);
  const startNumber = ordered ? Number.parseInt(first.marker, 10) : 1;
  const items: MessageBlock[][] = [];

  let i = start;
  while (i < lines.length) {
    const item = matchItem(lines[i]);
    if (!item || item.indent >= baseIndent + 2 || isOrderedMarker(item.marker) !== ordered) break;
    const { body, next } = collectItemBody(lines, i, baseIndent, item);
    items.push(parseBlocks(body, depth + 1));
    i = nextLooseItem(lines, next, baseIndent, ordered);
  }

  return { block: { kind: 'list', ordered, start: startNumber, items }, next: i };
}

function readFence(lines: string[], i: number): BlockRead | null {
  const fence = FENCE.exec(lines[i]);
  if (!fence) return null;
  const body: string[] = [];
  let j = i + 1;
  while (j < lines.length && !closesFence(lines[j], fence[1])) body.push(lines[j++]);
  // Past the closing fence (an unclosed one runs to the end of the message).
  return { block: { kind: 'code', text: body.join('\n') }, next: j + 1 };
}

function readHeading(lines: string[], i: number): BlockRead | null {
  const heading = HEADING.exec(lines[i]);
  if (!heading) return null;
  const level = Math.min(heading[1].length, 3) as 1 | 2 | 3;
  return { block: { kind: 'heading', level, text: headingText(heading[2]) }, next: i + 1 };
}

function readRule(lines: string[], i: number): BlockRead | null {
  return RULE.test(lines[i]) ? { block: { kind: 'rule' }, next: i + 1 } : null;
}

function readQuote(lines: string[], i: number, depth: number): BlockRead | null {
  if (depth >= MAX_DEPTH || !QUOTE.test(lines[i])) return null;
  const quoted: string[] = [];
  let j = i;
  while (j < lines.length) {
    const q = QUOTE.exec(lines[j]);
    if (!q) break;
    quoted.push(q[1]);
    j++;
  }
  return { block: { kind: 'quote', blocks: parseBlocks(quoted, depth + 1) }, next: j };
}

function readList(lines: string[], i: number, depth: number): BlockRead | null {
  return depth < MAX_DEPTH && matchItem(lines[i]) ? parseList(lines, i, depth) : null;
}

/** The cells of a `| a | b |` row (outer pipes optional, `\|` stays a literal pipe). */
export function splitTableRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let k = 0; k < text.length; k++) {
    const ch = text[k];
    if (ch === '\\' && text[k + 1] === '|') {
      cell += '|';
      k++;
    } else if (ch === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

/** `---`, `:--`, `--:` or `:-:`: a delimiter cell, read as its column's alignment. */
function delimiterAlign(cell: string): TableAlign | undefined {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  const dashes = cell.slice(left ? 1 : 0, right ? cell.length - 1 : cell.length);
  if (dashes.length === 0 || dashes.replaceAll('-', '') !== '') return undefined;
  if (left && right) return 'center';
  if (right) return 'right';
  return left ? 'left' : null;
}

/** The alignments of a delimiter row (`|---|:-:|`), or null when the line is not one. */
function readDelimiterRow(line: string | undefined): TableAlign[] | null {
  if (!line?.includes('-')) return null;
  const align = splitTableRow(line).map(delimiterAlign);
  return align.every((a) => a !== undefined) ? (align as TableAlign[]) : null;
}

/** A row cut or padded to the header's width. */
function fitRow(cells: string[], width: number): string[] {
  return Array.from({ length: width }, (_, k) => cells[k] ?? '');
}

/** A GitHub-style table: a header row, a delimiter row of dashes, then rows with `|`. */
function readTable(lines: string[], i: number): BlockRead | null {
  if (!lines[i].includes('|')) return null;
  const align = readDelimiterRow(lines[i + 1]);
  const header = splitTableRow(lines[i]);
  if (!align || align.length !== header.length || header.length > MAX_TABLE_COLUMNS) return null;

  const rows: string[][] = [];
  let j = i + 2;
  while (j < lines.length && lines[j].trim() !== '' && lines[j].includes('|') && rows.length < MAX_TABLE_ROWS) {
    rows.push(fitRow(splitTableRow(lines[j]), header.length));
    j++;
  }
  return { block: { kind: 'table', header, align, rows }, next: j };
}

const BLOCK_READERS: ReadonlyArray<(lines: string[], i: number, depth: number) => BlockRead | null> = [
  readFence,
  readHeading,
  readTable,
  readRule,
  readQuote,
  readList,
];

function readBlock(lines: string[], i: number, depth: number): BlockRead | null {
  for (const read of BLOCK_READERS) {
    const result = read(lines, i, depth);
    if (result) return result;
  }
  return null;
}

function parseBlocks(lines: string[], depth: number): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
      paragraph = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const blank = line.trim() === '';
    const read = blank ? null : readBlock(lines, i, depth);
    if (read) {
      flush();
      blocks.push(read.block);
      i = read.next;
      continue;
    }
    if (blank) flush();
    else paragraph.push(line.trim());
    i++;
  }
  flush();
  return blocks;
}

/**
 * The block structure of a message body: paragraphs (separated by blank lines),
 * lists, headings, fenced code, quotes, tables and rules. Never throws; text it
 * does not understand stays a paragraph.
 */
export function parseMessageBlocks(text: string): MessageBlock[] {
  return parseBlocks(text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n').map(expandTabs), 0);
}

/** Whether the parsed message is anything more than one plain paragraph. */
export function hasBlockMarkup(blocks: readonly MessageBlock[]): boolean {
  return blocks.length > 1 || (blocks.length === 1 && blocks[0].kind !== 'paragraph');
}

interface RenderContext {
  members?: Map<string, string>;
  files?: InlineFileRenderer;
}

function renderInline(text: string, ctx: RenderContext): ReactNode {
  return renderMessageContent(text, ctx.members, ctx.files);
}

function renderListItem(blocks: MessageBlock[], ctx: RenderContext, key: string): ReactNode {
  return (
    <li key={key} className="[&>*+*]:mt-0.5">
      {blocks.map((block, i) =>
        block.kind === 'paragraph' ? (
          <div key={`${key}.${i}`} className="whitespace-pre-wrap">
            {renderInline(block.text, ctx)}
          </div>
        ) : (
          renderBlock(block, ctx, `${key}.${i}`)
        ),
      )}
    </li>
  );
}

const ALIGN_CLASS: Record<'left' | 'center' | 'right', string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

function alignClass(align: TableAlign | undefined): string {
  return align ? ALIGN_CLASS[align] : 'text-left';
}

/** A table scrolls sideways inside the message instead of widening the chat. */
function renderTable(block: Extract<MessageBlock, { kind: 'table' }>, ctx: RenderContext, key: string): ReactNode {
  return (
    <div key={key} className="max-w-full overflow-x-auto rounded-md border">
      <table className="w-full border-collapse text-[13px]">
        <thead className="bg-muted/60">
          <tr>
            {block.header.map((cell, c) => (
              <th key={`${key}.h${c}`} className={cn('px-2.5 py-1 font-semibold', alignClass(block.align[c]))}>
                {renderInline(cell, ctx)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={`${key}.r${r}`}>
              {row.map((cell, c) => (
                <td key={`${key}.r${r}.${c}`} className={cn('border-t px-2.5 py-1 align-top', alignClass(block.align[c]))}>
                  {renderInline(cell, ctx)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderBlock(block: MessageBlock, ctx: RenderContext, key: string): ReactNode {
  switch (block.kind) {
    case 'table':
      return renderTable(block, ctx, key);
    case 'paragraph':
      return (
        <p key={key} className="whitespace-pre-wrap">
          {renderInline(block.text, ctx)}
        </p>
      );
    case 'heading':
      return (
        <p key={key} className={cn('font-semibold', block.level === 1 && 'text-base')}>
          {renderInline(block.text, ctx)}
        </p>
      );
    case 'list': {
      const items = block.items.map((item, i) => renderListItem(item, ctx, `${key}.${i}`));
      return block.ordered ? (
        <ol key={key} start={block.start} className="list-decimal space-y-0.5 pl-5 marker:text-muted-foreground">
          {items}
        </ol>
      ) : (
        <ul key={key} className="list-disc space-y-0.5 pl-5 marker:text-muted-foreground">
          {items}
        </ul>
      );
    }
    case 'code':
      return (
        <pre key={key} className="overflow-x-auto whitespace-pre rounded-md bg-muted px-3 py-2 font-mono text-[13px]">
          {block.text}
        </pre>
      );
    case 'quote':
      return (
        <blockquote key={key} className="space-y-1.5 border-l-2 border-muted-foreground/30 pl-3 text-muted-foreground">
          {block.blocks.map((inner, i) => renderBlock(inner, ctx, `${key}.${i}`))}
        </blockquote>
      );
    default:
      return <hr key={key} className="my-1 border-border" />;
  }
}

/**
 * Renders an agent's message body: markdown blocks around the same inline
 * rendering every other message uses. A plain single-paragraph message (or one
 * too long to parse) renders exactly like `renderMessageContent` does.
 */
export function renderMessageBlocks(
  text: string,
  members?: Map<string, string>,
  files?: InlineFileRenderer,
): ReactNode {
  if (text.length > MAX_EMPHASIS_CHARS) return renderMessageContent(text, members, files);
  const blocks = parseMessageBlocks(text);
  if (!hasBlockMarkup(blocks)) return renderMessageContent(text, members, files);

  const ctx: RenderContext = { members, files };
  return <div className="space-y-1.5">{blocks.map((block, i) => renderBlock(block, ctx, `b${i}`))}</div>;
}
