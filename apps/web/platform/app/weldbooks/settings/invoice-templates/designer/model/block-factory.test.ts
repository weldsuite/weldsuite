import { describe, expect, it } from 'vitest';
import { invoiceTemplateDocumentSchema, type TemplateBlockType } from '@weldsuite/books-domain/invoice-template/schema';
import { presetTemplate } from '@weldsuite/books-domain/invoice-template/presets';
import {
  PALETTE_GROUPS,
  canAddBlock,
  createBlock,
  minSizeOf,
  newBlockId,
  placementForNew,
  removableIds,
} from './block-factory';

const ALL_TYPES: TemplateBlockType[] = PALETTE_GROUPS.flatMap((g) => g.types);

describe('createBlock', () => {
  it('covers every block type the schema knows', () => {
    expect(new Set(ALL_TYPES).size).toBe(16);
  });

  it.each(ALL_TYPES)('creates a valid %s block', (type) => {
    const doc = presetTemplate('classic', 'a4');
    const blocks = type === 'lineItems' ? doc.blocks : [...doc.blocks, createBlock(type, `${type}-x`)];
    const result = invoiceTemplateDocumentSchema.safeParse({ ...doc, blocks });
    expect(result.success, JSON.stringify(result.success ? '' : result.error.issues)).toBe(true);
  });

  it('puts the block where it is asked and honours the text', () => {
    const block = createBlock('text', 'text-1', { x: 20, y: 30, text: 'Thank you' });
    expect(block).toMatchObject({ x: 20, y: 30, type: 'text', text: 'Thank you' });
  });
});

describe('newBlockId', () => {
  it('counts up past taken ids', () => {
    expect(newBlockId('text', [])).toBe('text-1');
    expect(newBlockId('text', ['text-1', 'text-2'])).toBe('text-3');
    expect(newBlockId('line', new Set(['text-1']))).toBe('line-1');
  });

  it('stays within the 40 character id limit', () => {
    expect(newBlockId('pageNumber', ['pageNumber-1']).length).toBeLessThanOrEqual(40);
  });
});

describe('placementForNew', () => {
  const page = { width: 595, height: 842 };

  it('snaps to the grid and stays on the page', () => {
    expect(placementForNew({ blocks: [] }, { w: 100, h: 20 }, { x: 13, y: 15 }, page)).toEqual({ x: 12, y: 16 });
    expect(placementForNew({ blocks: [] }, { w: 100, h: 20 }, { x: 900, y: 900 }, page)).toEqual({ x: 495, y: 822 });
  });

  it('cascades when a block already sits there', () => {
    const blocks = [createBlock('text', 'a', { x: 12, y: 16 })];
    expect(placementForNew({ blocks }, { w: 100, h: 20 }, { x: 12, y: 16 }, page)).toEqual({ x: 24, y: 28 });
  });
});

describe('table protection', () => {
  const doc = presetTemplate('classic', 'a4');

  it('only allows one line-items table', () => {
    expect(canAddBlock(doc, 'lineItems')).toBe(false);
    expect(canAddBlock(doc, 'text')).toBe(true);
  });

  it('never lists the table as removable', () => {
    expect(removableIds(doc, ['title', 'items'])).toEqual(['title']);
  });
});

describe('minSizeOf', () => {
  it('is 4pt for boxes and keeps the thin side of a line thin', () => {
    expect(minSizeOf({ type: 'text' })).toEqual({ minW: 4, minH: 4 });
    expect(minSizeOf({ type: 'line' })).toEqual({ minW: 4, minH: 1 });
    expect(minSizeOf({ type: 'line', orientation: 'vertical' })).toEqual({ minW: 2, minH: 4 });
  });
});
