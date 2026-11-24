/**
 * The Markdown subset of `richtext` settings, drawn as React elements:
 * paragraphs (a blank line between), `**bold**`, `*italic*`,
 * `[label](https://…)`, `- ` lists and `## ` / `### ` headings. A single line
 * break inside a paragraph is kept. Nothing is ever inserted as HTML: text
 * goes in as text, and a link whose URL is not safe (see `safeLink`) is drawn
 * as its label alone.
 */

import { Fragment, type ReactNode } from 'react';
import { safeLink } from './links';

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'link'; href: string; external: boolean; children: Inline[] }
  | { kind: 'break' };

export type MarkdownBlock =
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'heading'; level: 2 | 3; children: Inline[] }
  | { kind: 'list'; items: Inline[][] };

/** The longest input parsed; the backend caps rich text at 20,000 characters too. */
const MAX_LENGTH = 20_000;

// `\S` after the spaces keeps these linear: the spaces and the text cannot
// trade characters, so a line that does not match fails without backtracking.
// The text group is undefined when nothing follows the spaces.
const LIST_ITEM = /^\s*[-*]\s+(\S.*)?$/;
const HEADING = /^(#{2,3})\s+(\S.*)?$/;

/** A `## ` / `### ` line's level and text; null for any other line. */
export function headingLine(line: string): { level: 2 | 3; text: string } | null {
  const match = HEADING.exec(line);
  if (!match) return null;
  return { level: match[1] === '##' ? 2 : 3, text: match[2] ?? '' };
}

/** The text of a `- ` / `* ` list item line; null for any other line. */
export function listItemLine(line: string): string | null {
  const match = LIST_ITEM.exec(line);
  return match ? (match[1] ?? '') : null;
}

/** Splits the text into paragraphs, headings and lists. */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const text = source.slice(0, MAX_LENGTH).replace(/\r\n?/g, '\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };
  const flushList = () => {
    if (list.length > 0) blocks.push({ kind: 'list', items: list.map((item) => parseInline(item)) });
    list = [];
  };

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = headingLine(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ kind: 'heading', level: heading.level, children: parseInline(heading.text) });
      continue;
    }
    const item = listItemLine(line);
    if (item !== null) {
      flushParagraph();
      list.push(item);
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return blocks;
}

/** The position of `marker` closing an emphasis that starts at `from`, or -1. */
function closing(text: string, marker: string, from: number): number {
  const at = text.indexOf(marker, from);
  // `**` inside `*…*` would close italic early: skip a `*` that is half of `**`.
  if (marker === '*' && at >= 0 && text[at + 1] === '*') return closing(text, marker, at + 2);
  return at;
}

/** The `[label](url)` starting at `start`, or null. */
function linkAt(text: string, start: number): { label: string; url: string; end: number } | null {
  const labelEnd = text.indexOf('](', start + 1);
  if (labelEnd < 0) return null;
  const label = text.slice(start + 1, labelEnd);
  if (label === '' || label.includes('\n') || label.includes('[')) return null;
  // The URL ends at the `)` that balances its own parentheses (`…/Foo_(bar)` stays whole).
  let depth = 0;
  for (let i = labelEnd + 2; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\n') return null;
    if (char === '(') depth += 1;
    else if (char === ')') {
      if (depth === 0) return { label, url: text.slice(labelEnd + 2, i), end: i + 1 };
      depth -= 1;
    }
  }
  return null;
}

/** The nodes markup at some position reads as, and the position after it. */
interface Markup {
  nodes: Inline[];
  end: number;
}

/** `**bold**` starting at `i`, or null. */
function strongAt(text: string, i: number, depth: number): Markup | null {
  if (!text.startsWith('**', i)) return null;
  let end = text.indexOf('**', i + 2);
  // In `***` the last two close the bold, so an italic inside it can close first.
  while (end > 0 && text[end + 2] === '*') end += 1;
  if (end <= i + 2) return null;
  return { nodes: [{ kind: 'strong', children: parseInline(text.slice(i + 2, end), depth + 1) }], end: end + 2 };
}

/** `*italic*` starting at `i`, or null. */
function emphasisAt(text: string, i: number, depth: number): Markup | null {
  if (text[i] !== '*' || text[i + 1] === '*' || text[i + 1] === ' ') return null;
  const end = closing(text, '*', i + 1);
  if (end <= i + 1) return null;
  return { nodes: [{ kind: 'em', children: parseInline(text.slice(i + 1, end), depth + 1) }], end: end + 1 };
}

/** `[label](url)` starting at `i`, or null; an unsafe URL leaves the label alone. */
function linkNodesAt(text: string, i: number, depth: number): Markup | null {
  if (text[i] !== '[') return null;
  const link = linkAt(text, i);
  if (!link) return null;
  const children = parseInline(link.label, depth + 1);
  const safe = safeLink(link.url);
  return { nodes: safe ? [{ kind: 'link', href: safe.href, external: safe.external, children }] : children, end: link.end };
}

/** The markup starting at `i`: a line break, bold, italic or a link; null for plain text. */
function markupAt(text: string, i: number, depth: number): Markup | null {
  if (text[i] === '\n') return { nodes: [{ kind: 'break' }], end: i + 1 };
  // Nesting is shallow in practice; past a few levels the markers stay text.
  if (depth >= 4) return null;
  return strongAt(text, i, depth) ?? emphasisAt(text, i, depth) ?? linkNodesAt(text, i, depth);
}

/** The character a backslash at `i` escapes (`\*`, `\[`, …), or null. */
function escapedAt(text: string, i: number): string | null {
  const next = text[i + 1];
  return text[i] === '\\' && next !== undefined && '*[]()\\'.includes(next) ? next : null;
}

/** Bold, italic, links and line breaks inside a block. */
export function parseInline(text: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer !== '') out.push({ kind: 'text', text: buffer });
    buffer = '';
  };

  let i = 0;
  while (i < text.length) {
    const markup = markupAt(text, i, depth);
    if (markup) {
      flush();
      out.push(...markup.nodes);
      i = markup.end;
      continue;
    }
    const escaped = escapedAt(text, i);
    buffer += escaped ?? text[i];
    i += escaped === null ? 1 : 2;
  }
  flush();
  return out;
}

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case 'text':
        return <Fragment key={index}>{node.text}</Fragment>;
      case 'break':
        return <br key={index} />;
      case 'strong':
        return <strong key={index}>{renderInline(node.children)}</strong>;
      case 'em':
        return <em key={index}>{renderInline(node.children)}</em>;
      case 'link':
        return (
          <a key={index} href={node.href} rel={node.external ? 'noopener noreferrer' : undefined}>
            {renderInline(node.children)}
          </a>
        );
    }
  });
}

export interface RichTextProps {
  /** The setting's value; anything but a string draws nothing. */
  source: unknown;
  className?: string;
  /**
   * The heading level `##` maps to. Sections whose own heading is an `h2`
   * pass 3, so the page outline stays in order.
   */
  baseLevel?: 2 | 3;
}

/** A `richtext` setting as React elements; nothing when it is empty. */
export function RichText({ source, className, baseLevel = 2 }: RichTextProps) {
  if (typeof source !== 'string' || source.trim() === '') return null;
  const blocks = parseMarkdown(source);
  if (blocks.length === 0) return null;
  return (
    <div className={className ?? 'shop-prose'}>
      {blocks.map((block, index) => {
        if (block.kind === 'paragraph') return <p key={index}>{renderInline(block.children)}</p>;
        if (block.kind === 'list') {
          return (
            <ul key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }
        const level = Math.min(block.level + (baseLevel - 2), 4);
        if (level === 2) return <h2 key={index}>{renderInline(block.children)}</h2>;
        if (level === 3) return <h3 key={index}>{renderInline(block.children)}</h3>;
        return <h4 key={index}>{renderInline(block.children)}</h4>;
      })}
    </div>
  );
}

/** The text of a `richtext` value without its markup, e.g. for a meta description. */
export function plainText(source: unknown, maxLength = 160): string {
  if (typeof source !== 'string') return '';
  const flatten = (nodes: Inline[]): string =>
    nodes
      .map((node) => {
        if (node.kind === 'text') return node.text;
        if (node.kind === 'break') return ' ';
        return flatten(node.children);
      })
      .join('');
  const text = parseMarkdown(source)
    .map((block) => (block.kind === 'list' ? block.items.map(flatten).join(' ') : flatten(block.children)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}
