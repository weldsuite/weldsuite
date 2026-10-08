import { describe, expect, it, vi } from 'vitest';
import type { Form1099PdfCopy } from '@/lib/api/domains/weldbooks-1099';
import { collectCopies } from './copies';

function pdfCopy(copy: 'B' | '1' | '2' | 'C', recipient = 'x'): Form1099PdfCopy {
  return {
    form: 'nec',
    copy,
    taxYear: 2026,
    page: { width: 612, height: 792, unit: 'pt', origin: 'top-left' },
    title: `Form 1099-NEC (${recipient})`,
    copyLabel: `Copy ${copy}`,
    labelFontSize: 6.5,
    valueFontSize: 10,
    fields: [],
    blocks: [],
    footer: '',
  };
}

describe('collectCopies', () => {
  it('collects the copies of every line, in the order of the lines, whatever order the answers come in', async () => {
    const delays: Record<string, number> = { a: 30, b: 1, c: 10 };
    const fetchCopies = vi.fn(async (lineId: string, copies: readonly ('B' | '1' | '2' | 'C')[]) => {
      await new Promise((resolve) => setTimeout(resolve, delays[lineId]));
      return { copies: copies.map((copy) => pdfCopy(copy, lineId)), warnings: [] };
    });
    const result = await collectCopies(fetchCopies, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], ['B', 'C']);
    expect(result.copies.map((c) => `${c.title}/${c.copy}`)).toEqual([
      'Form 1099-NEC (a)/B',
      'Form 1099-NEC (a)/C',
      'Form 1099-NEC (b)/B',
      'Form 1099-NEC (b)/C',
      'Form 1099-NEC (c)/B',
      'Form 1099-NEC (c)/C',
    ]);
    expect(result.failed).toEqual([]);
    expect(fetchCopies).toHaveBeenCalledWith('a', ['B', 'C']);
  });

  it('skips a line that fails and reports it, so one recipient without a TIN does not stop the rest', async () => {
    const fetchCopies = async (lineId: string) => {
      if (lineId === 'b') throw new Error('This recipient has no TIN on the filing yet');
      return { copies: [pdfCopy('B', lineId)], warnings: [] };
    };
    const result = await collectCopies(fetchCopies, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], ['B']);
    expect(result.copies).toHaveLength(2);
    expect(result.failed).toEqual([{ lineId: 'b', message: 'This recipient has no TIN on the filing yet' }]);
  });

  it('lists each warning once', async () => {
    const fetchCopies = async () => ({ copies: [pdfCopy('B')], warnings: ['The payer TIN is printed truncated.'] });
    const result = await collectCopies(fetchCopies, [{ id: 'a' }, { id: 'b' }], ['B']);
    expect(result.warnings).toEqual(['The payer TIN is printed truncated.']);
  });

  it('reports progress as lines finish, and never runs more than a few requests at once', async () => {
    let running = 0;
    let peak = 0;
    const fetchCopies = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 2));
      running -= 1;
      return { copies: [pdfCopy('B')], warnings: [] };
    };
    const progress: number[] = [];
    const lines = Array.from({ length: 12 }, (_, i) => ({ id: `l${i}` }));
    await collectCopies(fetchCopies, lines, ['B'], (done, total) => {
      expect(total).toBe(12);
      progress.push(done);
    });
    expect(progress).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('has nothing to do for no lines', async () => {
    const fetchCopies = vi.fn();
    expect(await collectCopies(fetchCopies, [], ['B'])).toEqual({ copies: [], warnings: [], failed: [] });
    expect(fetchCopies).not.toHaveBeenCalled();
  });
});
