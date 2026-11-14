import { describe, expect, it } from 'vitest';
import type { FormFieldSummary } from '@weldsuite/app-api-client/schemas/weldforms';
import { npsTone, percentOf, toSummaryCard } from './summary-cards';

const base = { blockId: 'b1', type: 't', title: 'Q', answered: 10 };

describe('percentOf', () => {
  it('rounds to one decimal and survives an empty total', () => {
    expect(percentOf(1, 3)).toBe(33.3);
    expect(percentOf(0, 0)).toBe(0);
  });
});

describe('toSummaryCard', () => {
  it('scales choice bars against the biggest one', () => {
    const field: FormFieldSummary = {
      ...base,
      kind: 'choice',
      choices: [
        { id: 'a', label: 'A', count: 6, percent: 60 },
        { id: 'b', label: 'B', count: 3, percent: 30 },
      ],
      other: 1,
      otherLatest: [],
    };
    const card = toSummaryCard(field);
    if (card.kind !== 'choice') throw new Error('kind');
    expect(card.bars.map((b) => b.width)).toEqual([100, 50]);
    expect(card.other).toBe(1);
  });

  it('splits NPS into segments and places the gauge', () => {
    const card = toSummaryCard({
      ...base,
      kind: 'nps',
      score: 50,
      promoters: 6,
      passives: 3,
      detractors: 1,
      distribution: [
        { value: 9, count: 4 },
        { value: 10, count: 2 },
      ],
    });
    if (card.kind !== 'nps') throw new Error('kind');
    expect(card.segments.map((s) => [s.id, s.percent])).toEqual([
      ['detractors', 10],
      ['passives', 30],
      ['promoters', 60],
    ]);
    expect(card.gauge).toBe(75);
    expect(card.bars.map((b) => b.height)).toEqual([100, 50]);
  });

  it('has no gauge without a score', () => {
    const card = toSummaryCard({ ...base, kind: 'nps', score: null, promoters: 0, passives: 0, detractors: 0, distribution: [] });
    if (card.kind !== 'nps') throw new Error('kind');
    expect(card.gauge).toBeNull();
    expect(card.segments.every((s) => s.percent === 0)).toBe(true);
  });

  it('splits yes and no', () => {
    const card = toSummaryCard({ ...base, kind: 'boolean', yes: 3, no: 1 });
    if (card.kind !== 'boolean') throw new Error('kind');
    expect([card.yesPercent, card.noPercent]).toEqual([75, 25]);
  });

  it('builds a heat table with a shared intensity scale', () => {
    const card = toSummaryCard({
      ...base,
      kind: 'matrix',
      columns: [
        { id: 'c1', label: 'Low' },
        { id: 'c2', label: 'High' },
      ],
      rows: [
        { id: 'r1', label: 'Speed', counts: { c1: 1, c2: 4 } },
        { id: 'r2', label: 'Price', counts: { c2: 2 } },
      ],
    });
    if (card.kind !== 'matrix') throw new Error('kind');
    expect(card.rows[0]?.total).toBe(5);
    expect(card.rows[0]?.cells.map((c) => c.intensity)).toEqual([0.25, 1]);
    expect(card.rows[1]?.cells.map((c) => c.count)).toEqual([0, 2]);
  });

  it('ranks by average rank and puts unranked choices last', () => {
    const card = toSummaryCard({
      ...base,
      kind: 'ranking',
      choices: [
        { id: 'a', label: 'A', averageRank: null },
        { id: 'b', label: 'B', averageRank: 2.4 },
        { id: 'c', label: 'C', averageRank: 1.2 },
      ],
    });
    if (card.kind !== 'ranking') throw new Error('kind');
    expect(card.choices.map((c) => [c.id, c.rank])).toEqual([
      ['c', 1],
      ['b', 2],
      ['a', null],
    ]);
  });
});

describe('npsTone', () => {
  it('bands the score', () => {
    expect(npsTone(null)).toBe('neutral');
    expect(npsTone(-5)).toBe('danger');
    expect(npsTone(10)).toBe('warning');
    expect(npsTone(45)).toBe('success');
  });
});
