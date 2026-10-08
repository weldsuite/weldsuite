import { describe, expect, it } from 'vitest';
import type { FixedAssetDetail } from '@/lib/api/domains/weldbooks-assets';
import {
  assetFormFromDetail,
  booksFromPreview,
  buildCreateInput,
  buildFromBillLineInput,
  buildUpdateInput,
  emptyAssetForm,
  emptyBook,
  makeAssetSchema,
  type AssetFormTexts,
  type AssetFormValues,
} from './asset-form-model';
import { previewDefaultBooks } from './asset-math';

const texts: AssetFormTexts = {
  nameRequired: 'name required',
  dateRequired: 'date required',
  dateInvalid: 'date invalid',
  amountInvalid: 'amount invalid',
  costPositive: 'cost positive',
  amountNegative: 'negative',
  percentRange: 'percent range',
  placedBeforeAcquired: 'placed before acquired',
  salvageOverCost: 'salvage over cost',
  lifeRange: 'life range',
  section179Over: 'section 179 over',
  recoveryPositive: 'recovery positive',
  stateRequired: 'state required',
  duplicateBook: 'duplicate book',
  oneLedgerBook: 'one ledger book',
  ledgerOnBook: 'ledger on book',
  section179NeedsMacrs: 'needs macrs',
};

const filled = (overrides: Partial<AssetFormValues> = {}): AssetFormValues => ({
  ...emptyAssetForm('2026-02-01'),
  name: '  Forklift  ',
  cost: '12,500.00',
  ...overrides,
});

describe('buildCreateInput', () => {
  it('sends only the required facts when everything else is left blank, so the server applies its defaults', () => {
    expect(buildCreateInput(filled(), { isUs: true })).toEqual({
      name: 'Forklift',
      acquisitionDate: '2026-02-01',
      cost: 12500,
    });
  });

  it('sends what the user typed, including a value equal to the default', () => {
    const input = buildCreateInput(
      filled({
        assetNumber: ' FA-7 ',
        description: 'Warehouse forklift',
        assetClass: '7',
        placedInServiceDate: '2026-02-10',
        salvageValue: '500',
        businessUsePercent: '100',
        listedProperty: true,
        usefulLifeYears: '8',
        section179Amount: '2500',
        bonusPercent: '60',
        bonusReducedElection: true,
        assetAccountId: 'acc_fa',
        classId: 'dim_1',
        notes: 'Bought from Acme',
      }),
      { isUs: true },
    );
    expect(input).toEqual({
      name: 'Forklift',
      acquisitionDate: '2026-02-01',
      cost: 12500,
      assetNumber: 'FA-7',
      description: 'Warehouse forklift',
      assetClass: '7',
      placedInServiceDate: '2026-02-10',
      salvageValue: 500,
      businessUsePercent: 100,
      listedProperty: true,
      usefulLifeYears: 8,
      section179Amount: 2500,
      bonusPercent: 60,
      bonusReducedElection: true,
      assetAccountId: 'acc_fa',
      classId: 'dim_1',
      notes: 'Bought from Acme',
    });
  });

  it('leaves listed property out when it is off, and sends no books unless they were customised', () => {
    const input = buildCreateInput(filled({ listedProperty: false, books: [emptyBook('book')] }), { isUs: true });
    expect(input.listedProperty).toBeUndefined();
    expect(input.books).toBeUndefined();
  });

  it('drops the US-only tax fields for another jurisdiction', () => {
    const input = buildCreateInput(
      filled({ assetClass: '5', businessUsePercent: '80', listedProperty: true, section179Amount: '100', bonusPercent: '50', bonusReducedElection: true, usefulLifeYears: '4' }),
      { isUs: false },
    );
    expect(input).toEqual({ name: 'Forklift', acquisitionDate: '2026-02-01', cost: 12500, usefulLifeYears: 4 });
  });

  it('sends the customised books, and no section 179 or bonus beside them', () => {
    const input = buildCreateInput(
      filled({
        customizeBooks: true,
        section179Amount: '999',
        bonusPercent: '10',
        books: [
          { ...emptyBook('book'), recoveryYears: '5' },
          { ...emptyBook('federal'), method: 'macrs_gds', recoveryYears: '5', section179Amount: '1000', bonusPercent: '', convention: 'half_year' },
          { ...emptyBook('state'), stateCode: 'ca', method: 'macrs_gds', recoveryYears: '5', bonusPercent: '0' },
        ],
      }),
      { isUs: true },
    );
    expect(input.section179Amount).toBeUndefined();
    expect(input.bonusPercent).toBeUndefined();
    expect(input.books).toEqual([
      { book: 'book', method: 'straight_line', recoveryYears: 5, postsToLedger: true },
      // A blank bonus is left to the server; MACRS follows the mid-quarter test, so no convention is sent.
      { book: 'federal', method: 'macrs_gds', recoveryYears: 5, postsToLedger: false, section179Amount: 1000 },
      { book: 'state', stateCode: 'CA', method: 'macrs_gds', recoveryYears: 5, postsToLedger: false, bonusPercent: 0 },
    ]);
  });

  it('sends the convention of a book method', () => {
    const input = buildCreateInput(
      filled({ customizeBooks: true, books: [{ ...emptyBook('book'), method: 'declining_balance', recoveryYears: '4', convention: 'mid_month' }] }),
      { isUs: true },
    );
    expect(input.books?.[0]).toEqual({ book: 'book', method: 'declining_balance', convention: 'mid_month', recoveryYears: 4, postsToLedger: true });
  });
});

describe('buildFromBillLineInput', () => {
  it('leaves the name, date and cost to the bill line when blank, and carries the reclass choice', () => {
    const values = { ...emptyAssetForm(''), assetClass: '5' };
    expect(buildFromBillLineInput(values, { isUs: true, billItemId: 'bi_1', reclass: false })).toEqual({ billItemId: 'bi_1', assetClass: '5' });
    expect(buildFromBillLineInput(values, { isUs: true, billItemId: 'bi_1', reclass: true })).toEqual({ billItemId: 'bi_1', assetClass: '5', reclass: true });
  });

  it('sends the overrides that were typed', () => {
    const values = { ...emptyAssetForm(''), name: 'Press', cost: '800', acquisitionDate: '2026-01-05' };
    expect(buildFromBillLineInput(values, { isUs: false, billItemId: 'bi_2', reclass: false })).toEqual({
      billItemId: 'bi_2',
      name: 'Press',
      cost: 800,
      acquisitionDate: '2026-01-05',
    });
  });
});

describe('makeAssetSchema', () => {
  const schema = makeAssetSchema(texts);
  const messages = (values: AssetFormValues, s = schema) => {
    const result = s.safeParse(values);
    return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  };

  it('accepts a minimal asset', () => {
    expect(messages(filled())).toEqual([]);
  });

  it('asks for a name, a date and a cost', () => {
    const result = messages({ ...emptyAssetForm(''), cost: '' });
    expect(result).toEqual(expect.arrayContaining(['name: name required', 'acquisitionDate: date required', 'cost: amount invalid']));
  });

  it('refuses a cost that is zero or not a number', () => {
    expect(messages(filled({ cost: '0' }))).toContain('cost: cost positive');
    expect(messages(filled({ cost: 'abc' }))).toContain('cost: amount invalid');
  });

  it('refuses a placed-in-service date before the acquisition date, and salvage above cost', () => {
    expect(messages(filled({ placedInServiceDate: '2026-01-01' }))).toContain('placedInServiceDate: placed before acquired');
    expect(messages(filled({ salvageValue: '20000' }))).toContain('salvageValue: salvage over cost');
  });

  it('keeps percentages and the life in range', () => {
    expect(messages(filled({ businessUsePercent: '120' }))).toContain('businessUsePercent: percent range');
    expect(messages(filled({ bonusPercent: '-1' }))).toContain('bonusPercent: percent range');
    expect(messages(filled({ usefulLifeYears: '0' }))).toContain('usefulLifeYears: life range');
  });

  it('caps section 179 at the business cost', () => {
    expect(messages(filled({ businessUsePercent: '50', section179Amount: '7000' }))).toContain('section179Amount: section 179 over');
    expect(messages(filled({ businessUsePercent: '50', section179Amount: '6250' }))).toEqual([]);
  });

  it('lets a bill line leave the name, date and cost blank, but not give a bad cost', () => {
    const billSchema = makeAssetSchema(texts, { billLine: true });
    expect(messages({ ...emptyAssetForm(''), assetClass: '5' }, billSchema)).toEqual([]);
    expect(messages({ ...emptyAssetForm(''), cost: '-5' }, billSchema)).toContain('cost: cost positive');
  });

  it('checks customised books: unique, one ledger book, a state, MACRS-only section 179', () => {
    const books = (rows: AssetFormValues['books']) => messages(filled({ customizeBooks: true, books: rows }));
    const ledger = { ...emptyBook('book'), recoveryYears: '5' };
    const federal = { ...emptyBook('federal'), recoveryYears: '5' };
    expect(books([ledger, federal])).toEqual([]);
    expect(books([ledger, { ...ledger }])).toContain('books.1.book: duplicate book');
    expect(books([{ ...emptyBook('state'), recoveryYears: '5' }])).toContain('books.0.stateCode: state required');
    expect(books([{ ...federal, postsToLedger: true }])).toContain('books.0.postsToLedger: ledger on book');
    expect(books([{ ...ledger, section179Amount: '100' }])).toContain('books.0.section179Amount: needs macrs');
    expect(books([{ ...ledger, recoveryYears: '' }])).toContain('books.0.recoveryYears: recovery positive');
    expect(books([{ ...emptyBook('book'), method: 'expensed', recoveryYears: '' }])).toEqual([]);
  });
});

describe('booksFromPreview', () => {
  it('starts the customised books from the preview, keeping only a bonus the user typed', () => {
    const preview = previewDefaultBooks({
      isUs: true,
      assetClass: '5',
      usefulLifeYears: null,
      acquisitionDate: '2025-06-01',
      placedInServiceDate: '2025-06-01',
      businessUsePercent: 100,
      listedProperty: false,
      section179Amount: 500,
      bonusPercent: null,
      bonusReducedElection: false,
    });
    const rows = booksFromPreview(preview);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ book: 'book', method: 'straight_line', recoveryYears: '5', postsToLedger: true });
    // The 100% bonus comes from the dates, so it stays blank and keeps following them.
    expect(rows[1]).toMatchObject({ book: 'federal', method: 'macrs_gds', recoveryYears: '5', section179Amount: '500', bonusPercent: '' });
  });
});

const detail = (overrides: Partial<FixedAssetDetail> = {}): FixedAssetDetail =>
  ({
    id: 'fa_1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    entityId: 'ent_1',
    assetNumber: 'FA-1',
    name: 'Forklift',
    description: null,
    assetClass: '7',
    assetAccountId: 'acc_fa',
    accumulatedDepreciationAccountId: 'acc_ad',
    depreciationExpenseAccountId: 'acc_de',
    acquisitionDate: '2026-02-01',
    placedInServiceDate: '2026-02-01',
    cost: '12500.00',
    salvageValue: '0.00',
    businessUsePercent: '100.0000',
    billId: null,
    billItemId: null,
    status: 'active',
    disposalDate: null,
    disposalProceeds: null,
    disposalJournalEntryId: null,
    classId: null,
    locationId: null,
    notes: null,
    books: [
      {
        id: 'fab_1',
        assetId: 'fa_1',
        book: 'book',
        stateCode: null,
        method: 'straight_line',
        convention: 'full_month',
        recoveryYears: '7.0',
        section179Amount: '0.00',
        bonusPercent: '0.0000',
        depreciableBasis: '12500.00',
        postsToLedger: true,
        schedule: { method: 'straight_line', convention: 'full_month', recoveryYears: 7, basis: {} as never, annual: [], issues: [] },
      },
      {
        id: 'fab_2',
        assetId: 'fa_1',
        book: 'federal',
        stateCode: null,
        method: 'macrs_gds',
        convention: 'half_year',
        recoveryYears: '7.0',
        section179Amount: '2500.00',
        bonusPercent: '100.0000',
        depreciableBasis: '0.00',
        postsToLedger: false,
        schedule: { method: 'macrs_gds', convention: 'half_year', recoveryYears: 7, basis: {} as never, annual: [], issues: [] },
      },
    ],
    ledgerRows: [],
    accumulatedPosted: '0.00',
    netBookValuePosted: '12500.00',
    issues: [],
    ...overrides,
  }) as FixedAssetDetail;

describe('buildUpdateInput', () => {
  const original = assetFormFromDetail(detail());

  it('fills the edit form from the stored asset', () => {
    expect(original).toMatchObject({
      name: 'Forklift',
      assetNumber: 'FA-1',
      cost: '12500',
      businessUsePercent: '',
      customizeBooks: true,
    });
    expect(original.books[1]).toMatchObject({ book: 'federal', recoveryYears: '7', section179Amount: '2500', bonusPercent: '100' });
  });

  it('sends nothing when nothing changed', () => {
    expect(buildUpdateInput(original, original, { locked: false, isUs: true })).toEqual({});
  });

  it('sends only the fields that changed', () => {
    const next = { ...original, name: 'Forklift 2', cost: '13000', notes: 'Serviced', placedInServiceDate: '2026-02-15' };
    expect(buildUpdateInput(next, original, { locked: false, isUs: true })).toEqual({
      name: 'Forklift 2',
      cost: 13000,
      notes: 'Serviced',
      placedInServiceDate: '2026-02-15',
    });
  });

  it('sends null to clear a text field', () => {
    expect(buildUpdateInput({ ...original, assetNumber: '' }, original, { locked: false, isUs: true })).toEqual({ assetNumber: null });
  });

  it('sends the books only when they changed', () => {
    const books = original.books.map((row) => (row.book === 'federal' ? { ...row, section179Amount: '1000' } : row));
    const input = buildUpdateInput({ ...original, books }, original, { locked: false, isUs: true });
    expect(input.books).toHaveLength(2);
    expect(input.books?.[1]).toMatchObject({ book: 'federal', section179Amount: 1000, bonusPercent: 100 });
  });

  it('never sends the financial facts or the books once depreciation is posted', () => {
    const books = original.books.map((row) => ({ ...row, recoveryYears: '10' }));
    const next = { ...original, name: 'Renamed', cost: '99999', acquisitionDate: '2025-01-01', assetAccountId: 'acc_other', books, notes: 'kept' };
    expect(buildUpdateInput(next, original, { locked: true, isUs: true })).toEqual({ name: 'Renamed', notes: 'kept' });
  });
});
