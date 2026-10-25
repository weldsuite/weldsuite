/**
 * Markdown out (CommonMark with GitHub's tables, task lists, strikethrough
 * and footnotes). What Markdown cannot say (colours, fonts, alignment, page
 * breaks) is left out.
 */

import { HEADING_STYLES } from '../model/defaults';
import { ListCounter, isOrdered } from '../model/numbering';
import type { TextStyle } from '../model/styles';
import { inlineText, lookup, toBlocks, type Block, type Inline, type ParagraphBlock, type TableBlock, type WriteSource } from './blocks';

export function toMarkdown(source: WriteSource): string {
  const writer = new MarkdownWriter(source);
  const tree = toBlocks(source.content);
  let out = writer.blocks(tree.blocks);
  if (tree.footnotes.length) {
    out += '\n';
    for (const fn of tree.footnotes) out += `\n[^${fn.number}]: ${writer.blocks(fn.blocks).replace(/\n+/g, ' ').trim()}`;
  }
  return out.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

const MONO = /courier|mono|consolas|menlo/i;

class MarkdownWriter {
  private readonly counter: ListCounter;
  private footnote = 0;

  constructor(source: WriteSource) {
    this.counter = new ListCounter(lookup(source.lists));
  }

  blocks(blocks: Block[]): string {
    const parts: string[] = [];
    let prevList = false;
    let i = 0;
    while (i < blocks.length) {
      const b = blocks[i]!;
      if (b.type === 'table') {
        parts.push(this.table(b));
        prevList = false;
        i++;
      } else if (b.props.style === 'code') {
        const fenced = codeBlock(blocks, i);
        parts.push(fenced.text);
        prevList = false;
        i = fenced.next;
      } else {
        const line = this.paragraph(b);
        const isList = !!b.props.list;
        // List items stay together; everything else is separated by a blank line.
        if (isList && prevList) parts[parts.length - 1] += `\n${line}`;
        else parts.push(line);
        prevList = isList;
        i++;
      }
    }
    return parts.join('\n\n');
  }

  private paragraph(b: ParagraphBlock): string {
    const text = this.inlines(b.inlines);
    const style = b.props.style ?? 'normal';
    const heading = (HEADING_STYLES as readonly string[]).indexOf(style);
    if (heading >= 0) return `${'#'.repeat(heading + 1)} ${text}`;
    if (style === 'title') return `# ${text}`;
    if (style === 'quote') return text.split('\n').map((l) => `> ${l}`).join('\n');
    if (b.props.list) {
      const indent = '    '.repeat(b.props.list.level);
      return `${indent}${this.listMarker(b)} ${text}`;
    }
    return escapeBlockStart(text);
  }

  /** `- [x]` for a checklist item, `3.` for a numbered one (its number as counted), else `-`. */
  private listMarker(b: ParagraphBlock): string {
    const list = this.counter.next(b.props);
    if (list?.level.format === 'check') return b.props.checked ? '- [x]' : '- [ ]';
    if (!isOrdered(list?.level)) return '-';
    const number = /\d+/.exec(list!.marker)?.[0] ?? '1';
    return `${number}.`;
  }

  inlines(inlines: Inline[]): string {
    let out = '';
    for (const inline of inlines) {
      switch (inline.type) {
        case 'text':
          out += this.text(inline.text, inline.style);
          break;
        case 'break':
          out += '\\\n';
          break;
        case 'tab':
          out += '\t';
          break;
        case 'object': {
          const d = inline.data;
          if (d.kind === 'image') out += `![${escapeInline(d.alt ?? '')}](${d.src.replace(/[()\s]/g, encodeURIComponent)})`;
          else if (d.kind === 'hr' || d.kind === 'pageBreak') out += '\n\n---\n\n';
          else if (d.kind === 'chip') out += this.text(d.label, inline.style);
          else if (d.kind === 'equation') out += `$${d.latex}$`;
          else if (d.kind === 'footnote') out += `[^${++this.footnote}]`;
          break;
        }
      }
    }
    return out;
  }

  private text(text: string, style: TextStyle): string {
    if (!text) return '';
    // Markup goes around the text without its outer whitespace (`**word** `, never `**word **`).
    const lead = text.slice(0, text.length - text.trimStart().length);
    const trail = text.slice(text.trimEnd().length);
    const core = text.slice(lead.length, text.length - trail.length);
    if (!core) return text;
    let out = style.font && MONO.test(style.font) ? codeSpan(core) : escapeInline(core);
    if (style.strike) out = `~~${out}~~`;
    if (style.italic) out = `*${out}*`;
    if (style.bold) out = `**${out}**`;
    if (style.link) out = `[${out}](${style.link.replace(/[()\s]/g, encodeURIComponent)})`;
    return lead + out + trail;
  }

  private table(t: TableBlock): string {
    const rows = t.rows.map((row) =>
      row.map((cell) =>
        cell.covered
          ? ''
          : cell.blocks
              .map((b) => (b.type === 'paragraph' ? this.inlines(b.inlines) : ''))
              .join('<br>')
              .replace(/\|/g, '\\|')
              .replace(/\n/g, ' '),
      ),
    );
    if (!rows.length) return '';
    const width = Math.max(...rows.map((r) => r.length));
    const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
    return [line(rows[0]!), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n');
  }
}

/** Consecutive code paragraphs from index `start` make one fenced block; returns it and the index after them. */
function codeBlock(blocks: Block[], start: number): { text: string; next: number } {
  const lines: string[] = [];
  let i = start;
  while (i < blocks.length && blocks[i]!.type === 'paragraph' && (blocks[i] as ParagraphBlock).props.style === 'code') {
    lines.push(inlineText((blocks[i] as ParagraphBlock).inlines));
    i++;
  }
  const fence = lines.some((l) => l.includes('```')) ? '~~~' : '```';
  return { text: `${fence}\n${lines.join('\n')}\n${fence}`, next: i };
}

function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(longest + 1);
  return longest ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

function escapeInline(text: string): string {
  return text.replace(/([\\`*_[\]<>~|])/g, '\\$1');
}

/** Escapes what would make a plain paragraph read as another block. */
function escapeBlockStart(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/^(\s*)([#>+-]|\d+[.)])(?=\s|$)/, '$1\\$2'))
    .join('\n');
}
