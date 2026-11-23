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

const LIST_ITEM = /^\s*[-*]\s+(.*)$/;
const HEADING = /^(#{2,3})\s+(.*)$/;

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
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ kind: 'heading', level: heading[1] === '##' ? 2 : 3, children: parseInline(heading[2] ?? '') });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flushParagraph();
      list.push(item[1] ?? '');
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
    const char = text[i];
    if (char === '\n') {
      flush();
      out.push({ kind: 'break' });
      i += 1;
      continue;
    }
    if (char === '\\' && i + 1 < text.length && '*[]()\\'.includes(text[i + 1] ?? '')) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }
    // Nesting is shallow in practice; past a few levels the markers stay text.
    if (depth < 4 && text.startsWith('**', i)) {
      let end = text.indexOf('**', i + 2);
      // In `***` the last two close the bold, so an italic inside it can close first.
      while (end > 0 && text[end + 2] === '*') end += 1;
      if (end > i + 2) {
        flush();
        out.push({ kind: 'strong', children: parseInline(text.slice(i + 2, end), depth + 1) });
        i = end + 2;
        continue;
      }
    }
    if (depth < 4 && char === '*' && text[i + 1] !== '*' && text[i + 1] !== ' ') {
      const end = closing(text, '*', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ kind: 'em', children: parseInline(text.slice(i + 1, end), depth + 1) });
        i = end + 1;
        continue;
      }
    }
    if (depth < 4 && char === '[') {
      const link = linkAt(text, i);
      if (link) {
        flush();
        const children = parseInline(link.label, depth + 1);
        const safe = safeLink(link.url);
        if (safe) out.push({ kind: 'link', href: safe.href, external: safe.external, children });
        else out.push(...children);
        i = link.end;
        continue;
      }
    }
    buffer += char;
    i += 1;
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
