/**
 * Plain text: paragraphs on their own lines, list markers kept, tables as
 * tab-separated rows (so a paste into a spreadsheet lands in cells).
 */

import { ListCounter } from '../model/numbering';
import { inlineText, lookup, toBlocks, type Block, type WriteSource } from './blocks';

export function toPlainText(source: WriteSource): string {
  const counter = new ListCounter(lookup(source.lists));
  const tree = toBlocks(source.content);
  const lines = writeBlocks(tree.blocks, counter);
  for (const fn of tree.footnotes) lines.push(`[${fn.number}] ${writeBlocks(fn.blocks, counter).join(' ')}`);
  return lines.join('\n');
}

function writeBlocks(blocks: Block[], counter: ListCounter): string[] {
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.type === 'paragraph') {
      const list = counter.next(b.props);
      const indent = list ? '  '.repeat(b.props.list?.level ?? 0) : '';
      lines.push(indent + (list ? `${list.marker} ` : '') + inlineText(b.inlines));
    } else {
      for (const row of b.rows) {
        lines.push(row.map((cell) => (cell.covered ? '' : writeBlocks(cell.blocks, counter).join(' '))).join('\t'));
      }
    }
  }
  return lines;
}
