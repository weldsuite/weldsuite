import { describe, expect, it } from 'vitest';
import {
  endOfLastMonth,
  formatShare,
  macrsClassOf,
  methodsFor,
  parseAmount,
  previewBonus,
  previewDefaultBooks,
  previewDisposal,
  toCents,
  type DefaultBooksFacts,
} from './asset-math';

const monthly = (start: string, amounts: number[]) =>
  amounts.map((amount, index) => {
    const month = String(Number(start.slice(5, 7)) + index).padStart(2, '0');
    return { periodStart: `${start.slice(0, 5)}${month}-01`, periodEnd: `${start.slice(0, 5)}${month}-28`, amount };
  });

describe('money helpers', () => {
  it('reads cents without floating point drift', () => {
    expect(toCents('19.99')).toBe(1999);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(-4.005)).toBe(-401);
    expect(toCents(null)).toBe(0);
    expect(toCents('abc')).toBe(0);
  });

  it('parses a form amount, or null when it is blank or not a number', () => {
    expect(parseAmount(' 1,250.50 ')).toBe(1250.5);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('x')).toBeNull();
    expect(parseAmount(7)).toBe(7);
  });

  it('formats a share as a percentage with one decimal', () => {
    expect(formatShare(0.425)).toBe('42.5%');
    expect(formatShare(0.4)).toBe('40.0%');
  });

  it('stops the depreciation run at the end of last month by default', () => {
    expect(endOfLastMonth('2026-03-15')).toBe('2026-02-28');
    expect(endOfLastMonth('2026-01-02')).toBe('2025-12-31');
    expect(endOfLastMonth('2028-03-01')).toBe('2028-02-29');
  });
});

describe('previewDisposal', () => {
  const rows = monthly('2026-01-01', [100, 100, 100, 100]);

  it('takes the depreciation of the periods that ended before the date and shows a gain over net book value', () => {
    // Jan to Mar ended before 2026-04-15: 300 depreciated, 1200 - 300 = 900 left; sold for 1000.
    const preview = previewDisposal({ cost: '1200.00', rows, date: '2026-04-15', proceeds: 1000 });
    expect(preview.accumulatedDepreciation).toBe(300);
    expect(preview.netBookValue).toBe(900);
    expect(preview.gainOrLoss).toBe(100);
    expect(preview.result).toBe('gain');
  });

  it('shows a loss when the proceeds are below net book value', () => {
    const preview = previewDisposal({ cost: 1200, rows, date: '2026-04-15', proceeds: '400.50' });
    expect(preview.netBookValue).toBe(900);
    expect(preview.gainOrLoss).toBe(-499.5);
    expect(preview.result).toBe('loss');
  });

  it('shows a scrapped asset (no proceeds) as a loss of its net book value', () => {
    const preview = previewDisposal({ cost: 1200, rows, date: '2026-04-15', proceeds: 0 });
    expect(preview.gainOrLoss).toBe(-900);
    expect(preview.result).toBe('loss');
  });

  it('shows no gain or loss when the proceeds equal net book value', () => {
    const preview = previewDisposal({ cost: 1200, rows, date: '2026-04-15', proceeds: 900 });
    expect(preview.gainOrLoss).toBe(0);
    expect(preview.result).toBe('none');
  });

  it('leaves the month of the disposal out, as the full-month convention does', () => {
    // Disposed on the last day of March: the March period ends on that day and is not counted.
    const preview = previewDisposal({ cost: 1200, rows: monthly('2026-01-01', [100, 100, 100]).map((row, i) => (i === 2 ? { ...row, periodEnd: '2026-03-31' } : row)), date: '2026-03-31', proceeds: 0 });
    expect(preview.accumulatedDepreciation).toBe(200);
  });

  it('adds cents exactly', () => {
    const odd = monthly('2026-01-01', [33.33, 33.33, 33.34]);
    const preview = previewDisposal({ cost: 1000, rows: odd, date: '2026-12-31', proceeds: 900 });
    expect(preview.accumulatedDepreciation).toBe(100);
    expect(preview.netBookValue).toBe(900);
    expect(preview.result).toBe('none');
  });

  it('is net book value at cost when nothing is depreciated yet', () => {
    const preview = previewDisposal({ cost: 500, rows, date: '2026-01-01', proceeds: 600 });
    expect(preview.accumulatedDepreciation).toBe(0);
    expect(preview.gainOrLoss).toBe(100);
  });
});

describe('previewBonus', () => {
  it('gives 100% for property acquired and placed in service after 19 January 2025', () => {
    expect(previewBonus({ acquisitionDate: '2025-06-01', placedInServiceDate: '2025-06-01' })).toEqual({ percent: 100, rule: 'obbba_100' });
  });

  it('gives 40% when the reduced election is made', () => {
    expect(previewBonus({ acquisitionDate: '2025-06-01', placedInServiceDate: '2025-06-01', reducedElection: true })).toEqual({
      percent: 40,
      rule: 'obbba_reduced_election',
    });
  });

  it('follows the TCJA phase-down for property acquired before the cutoff', () => {
    expect(previewBonus({ acquisitionDate: '2023-03-01', placedInServiceDate: '2023-03-01' }).percent).toBe(80);
    expect(previewBonus({ acquisitionDate: '2024-03-01', placedInServiceDate: '2024-03-01' }).percent).toBe(60);
    expect(previewBonus({ acquisitionDate: '2019-03-01', placedInServiceDate: '2019-03-01' }).percent).toBe(100);
  });

  it('does not model property acquired before the TCJA', () => {
    expect(previewBonus({ acquisitionDate: '2016-03-01', placedInServiceDate: '2016-03-01' }).rule).toBe('not_modeled');
  });
});

describe('previewDefaultBooks', () => {
  const facts: DefaultBooksFacts = {
    isUs: true,
    assetClass: '5',
    usefulLifeYears: null,
    acquisitionDate: '2025-06-01',
    placedInServiceDate: '2025-06-01',
    businessUsePercent: 100,
    listedProperty: false,
    section179Amount: null,
    bonusPercent: null,
    bonusReducedElection: false,
  };

  it('creates the ledger book over the MACRS class life and a federal MACRS book for a US asset', () => {
    const books = previewDefaultBooks(facts);
    expect(books.map((book) => book.book)).toEqual(['book', 'federal']);
    expect(books[0]).toMatchObject({ method: 'straight_line', convention: 'full_month', recoveryYears: 5, postsToLedger: true });
    expect(books[1]).toMatchObject({ method: 'macrs_gds', convention: 'half_year', recoveryYears: 5, postsToLedger: false, bonusPercent: 100, bonusRule: 'obbba_100' });
  });

  it('uses the typed useful life for the ledger book and 5 years when there is no class', () => {
    expect(previewDefaultBooks({ ...facts, usefulLifeYears: 8 })[0]?.recoveryYears).toBe(8);
    const noClass = previewDefaultBooks({ ...facts, assetClass: null });
    expect(noClass).toHaveLength(1);
    expect(noClass[0]?.recoveryYears).toBe(5);
  });

  it('makes only the ledger book outside the US', () => {
    const books = previewDefaultBooks({ ...facts, isUs: false });
    expect(books).toHaveLength(1);
    expect(books[0]?.book).toBe('book');
  });

  it('uses the mid-month convention and no bonus for residential rental property', () => {
    const federal = previewDefaultBooks({ ...facts, assetClass: '27.5' })[1];
    expect(federal).toMatchObject({ convention: 'mid_month', bonusPercent: 0, bonusRule: 'not_eligible' });
  });

  it('keeps a bonus percentage the user typed, and the section 179 amount', () => {
    const federal = previewDefaultBooks({ ...facts, bonusPercent: 60, section179Amount: 2500 })[1];
    expect(federal).toMatchObject({ bonusPercent: 60, bonusRule: 'entered', section179Amount: 2500 });
  });

  it('converts listed property used 50% or less for business to ADS without section 179 or bonus', () => {
    const federal = previewDefaultBooks({ ...facts, listedProperty: true, businessUsePercent: 40, section179Amount: 1000, bonusPercent: 50 })[1];
    expect(federal).toMatchObject({ method: 'macrs_ads', convertedToAds: true, section179Amount: 0, bonusPercent: 0, bonusRule: 'not_allowed' });
  });

  it('follows the reduced bonus election', () => {
    const federal = previewDefaultBooks({ ...facts, bonusReducedElection: true })[1];
    expect(federal).toMatchObject({ bonusPercent: 40, bonusRule: 'obbba_reduced_election' });
  });
});

describe('book vocabulary', () => {
  it('reads a MACRS class, and nothing for a free-text category', () => {
    expect(macrsClassOf('27.5')).toBe(27.5);
    expect(macrsClassOf('furniture')).toBeNull();
    expect(macrsClassOf('')).toBeNull();
  });

  it('keeps MACRS off the ledger book', () => {
    expect(methodsFor('book')).not.toContain('macrs_gds');
    expect(methodsFor('federal')).toContain('macrs_gds');
  });
});
