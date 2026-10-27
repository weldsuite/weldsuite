/**
 * Block-level markdown for agent-authored WeldChat messages.
 *
 * Agents answer in markdown: paragraphs, `-` / `1.` lists (nested too), `#`
 * headings, fenced code and quotes. People write plain text in the composer, so
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

export type MessageBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: MessageBlock[][] }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; blocks: MessageBlock[] }
  | { kind: 'rule' };

/** Lists and quotes nest this deep; anything below is plain text. */
const MAX_DEPTH = 4;

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
/** indent · marker (`-`, `*`, `+`, `•`, `1.`, `1)`) · gap · text */
const ITEM = /^( *)([-*+•]|\d{1,4}[.)])( +)(.*)$/;

function expandTabs(line: string): string {
  return line.replace(/^\t+/, (tabs) => '    '.repeat(tabs.length));
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function matchItem(line: string): { indent: number; marker: string; gap: number; text: string } | null {
  const m = ITEM.exec(line);
  return m ? { indent: m[1].length, marker: m[2], gap: Math.min(m[3].length, 4), text: m[4] } : null;
}

const isOrderedMarker = (marker: string): boolean => /\d/.test(marker);

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || matchItem(line) !== null;
}

function closesFence(line: string, opener: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= opener.length && trimmed === opener[0].repeat(trimmed.length);
}

function parseList(lines: string[], start: number, depth: number): { block: MessageBlock; next: number } {
  const first = matchItem(lines[start]) as NonNullable<ReturnType<typeof matchItem>>;
  const baseIndent = first.indent;
  const ordered = isOrderedMarker(first.marker);
  const startNumber = ordered ? Number.parseInt(first.marker, 10) : 1;
  const items: MessageBlock[][] = [];

  let i = start;
  while (i < lines.length) {
    const item = matchItem(lines[i]);
    if (!item || item.indent >= baseIndent + 2 || isOrderedMarker(item.marker) !== ordered) break;

    const contentIndent = item.indent + item.marker.length + item.gap;
    const body: string[] = [item.text];
    let j = i + 1;
    while (j < lines.length) {
      const line = lines[j];
      if (line.trim() === '') {
        // Blank lines stay in the item only when an indented continuation follows.
        let k = j + 1;
        while (k < lines.length && lines[k].trim() === '') k++;
        if (k < lines.length && indentOf(lines[k]) >= baseIndent + 2) {
          for (let b = j; b < k; b++) body.push('');
          j = k;
          continue;
        }
        break;
      }
      const indent = indentOf(line);
      if (indent >= baseIndent + 2) {
        body.push(line.slice(Math.min(contentIndent, indent)));
        j++;
        continue;
      }
      if (startsBlock(line)) break;
      // Lazy continuation: a wrapped line of the item's text.
      if (lines[j - 1].trim() !== '') {
        body.push(line.trim());
        j++;
        continue;
      }
      break;
    }
    items.push(parseBlocks(body, depth + 1));
    i = j;

    // A loose list (blank line between items) is still one list.
    let k = i;
    while (k < lines.length && lines[k].trim() === '') k++;
    if (k > i && k < lines.length) {
      const next = matchItem(lines[k]);
      if (next && next.indent < baseIndent + 2 && isOrderedMarker(next.marker) === ordered) i = k;
    }
  }

  return { block: { kind: 'list', ordered, start: startNumber, items }, next: i };
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
    if (line.trim() === '') {
      flush();
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !closesFence(lines[i], fence[1])) body.push(lines[i++]);
      i++; // the closing fence (an unclosed one runs to the end of the message)
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: Math.min(heading[1].length, 3) as 1 | 2 | 3, text: heading[2] });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: 'rule' });
      i++;
      continue;
    }

    if (depth < MAX_DEPTH && QUOTE.test(line)) {
      flush();
      const quoted: string[] = [];
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i]);
        if (!q) break;
        quoted.push(q[1]);
        i++;
      }
      blocks.push({ kind: 'quote', blocks: parseBlocks(quoted, depth + 1) });
      continue;
    }

    if (depth < MAX_DEPTH && matchItem(line)) {
      flush();
      const { block, next } = parseList(lines, i, depth);
      blocks.push(block);
      i = next;
      continue;
    }

    paragraph.push(line.trim());
    i++;
  }
  flush();
  return blocks;
}

/**
 * The block structure of a message body: paragraphs (separated by blank lines),
 * lists, headings, fenced code, quotes and rules. Never throws; text it does not
 * understand stays a paragraph.
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

function renderBlock(block: MessageBlock, ctx: RenderContext, key: string): ReactNode {
  switch (block.kind) {
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
