import { beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({
  get: vi.fn(),
  getBlob: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../weldbooks-client', () => ({ weldbooksApi: client }));

import { accountingApi, reportQueryString } from './weldbooks';

beforeEach(() => {
  Object.values(client).forEach((fn) => fn.mockReset());
  client.get.mockResolvedValue({ data: {} });
  client.getBlob.mockResolvedValue({ blob: new Blob(['x']), filename: 'report.csv' });
});

describe('reportQueryString', () => {
  it('leaves out empty values and the json format', () => {
    expect(reportQueryString({})).toBe('');
    expect(reportQueryString({ from: '2026-01-01', to: '', basis: 'cash' }, 'json')).toBe('?from=2026-01-01&basis=cash');
  });

  it('adds the export format', () => {
    expect(reportQueryString({ compare: 'prior_year', classId: 'dim_1' }, 'csv')).toBe('?compare=prior_year&classId=dim_1&format=csv');
    expect(reportQueryString({ year: 2026, includeZero: true }, 'print')).toBe('?year=2026&includeZero=true&format=print');
  });
});

describe('report requests', () => {
  it('sends the toolbar request to the report endpoint', async () => {
    await accountingApi.getProfitLoss({ from: '2026-01-01', to: '2026-12-31', basis: 'cash', periods: 'months' });
    expect(client.get).toHaveBeenCalledWith('/accounting-reports/profit-loss?from=2026-01-01&to=2026-12-31&basis=cash&periods=months');

    await accountingApi.getGeneralLedger({ accountId: 'acc_1', page: 2, pageSize: 50 });
    expect(client.get).toHaveBeenLastCalledWith('/accounting-reports/general-ledger?accountId=acc_1&page=2&pageSize=50');

    await accountingApi.getTaxWorksheet({ year: 2026 });
    expect(client.get).toHaveBeenLastCalledWith('/accounting-reports/tax-worksheet?year=2026');

    await accountingApi.getAgedPayables();
    expect(client.get).toHaveBeenLastCalledWith('/accounting-reports/aged-payables');
  });

  it('downloads the CSV and the print document of a report', async () => {
    const csv = await accountingApi.downloadReportCsv('balance-sheet', { asOf: '2026-12-31', basis: 'accrual' });
    expect(client.getBlob).toHaveBeenCalledWith('/accounting-reports/balance-sheet?asOf=2026-12-31&basis=accrual&format=csv');
    expect(csv.filename).toBe('report.csv');

    await accountingApi.getReportPrintDocument('cash-flow', { from: '2026-01-01' });
    expect(client.get).toHaveBeenLastCalledWith('/accounting-reports/cash-flow?from=2026-01-01&format=print');
  });
});

describe('entity setup requests', () => {
  it('applies the tax lines of an entity and reveals its SSN with an optional reason', async () => {
    client.post.mockResolvedValue({ data: {} });
    await accountingApi.applyTaxLines('ent_1', { overwrite: true });
    expect(client.post).toHaveBeenLastCalledWith('/accounting-entities/ent_1/apply-tax-lines', { overwrite: true });

    await accountingApi.applyTaxLines('ent_1');
    expect(client.post).toHaveBeenLastCalledWith('/accounting-entities/ent_1/apply-tax-lines', {});

    await accountingApi.revealEntitySsn('ent_1');
    expect(client.post).toHaveBeenLastCalledWith('/accounting-entities/ent_1/reveal-ssn', {});
    await accountingApi.revealEntitySsn('ent_1', 'IRS letter');
    expect(client.post).toHaveBeenLastCalledWith('/accounting-entities/ent_1/reveal-ssn', { reason: 'IRS letter' });
  });

  it('lists the tax lines of a year and the unmapped accounts', async () => {
    await accountingApi.getTaxLines(2025);
    expect(client.get).toHaveBeenLastCalledWith('/gl-accounts/tax-lines?year=2025');
    await accountingApi.getTaxLines();
    expect(client.get).toHaveBeenLastCalledWith('/gl-accounts/tax-lines');
    await accountingApi.listAccounts({ taxLine: 'none' });
    expect(client.get).toHaveBeenLastCalledWith('/gl-accounts?taxLine=none');
  });
});

describe('dimension requests', () => {
  it('filters, creates, updates and deletes values', async () => {
    client.post.mockResolvedValue({ data: {} });
    client.patch.mockResolvedValue({ data: {} });
    client.delete.mockResolvedValue(undefined);

    await accountingApi.listDimensionValues({ dimension: 'location', isActive: true, limit: 500 });
    expect(client.get).toHaveBeenLastCalledWith('/accounting-dimensions?dimension=location&isActive=true&limit=500');

    await accountingApi.createDimensionValue({ dimension: 'class', name: 'Retail', code: null, parentId: 'dim_1' });
    expect(client.post).toHaveBeenLastCalledWith('/accounting-dimensions', {
      dimension: 'class',
      name: 'Retail',
      code: null,
      parentId: 'dim_1',
    });

    await accountingApi.updateDimensionValue('dim_2', { isActive: false });
    expect(client.patch).toHaveBeenLastCalledWith('/accounting-dimensions/dim_2', { isActive: false });

    await accountingApi.deleteDimensionValue('dim_2');
    expect(client.delete).toHaveBeenLastCalledWith('/accounting-dimensions/dim_2');
  });
});
