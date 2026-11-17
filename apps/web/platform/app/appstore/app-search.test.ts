import { describe, expect, it } from 'vitest';
import { matchesAppFilters, matchesAppQuery } from './app-search';

const crm = ['WeldCRM', 'weldcrm', 'Win more deals with a CRM', 'Sales & Marketing', 'Customers'];

describe('matchesAppQuery', () => {
  it('matches everything for an empty or blank query', () => {
    expect(matchesAppQuery('', crm)).toBe(true);
    expect(matchesAppQuery('   ', crm)).toBe(true);
  });

  it('matches part of the name, ignoring case', () => {
    expect(matchesAppQuery('crm', crm)).toBe(true);
    expect(matchesAppQuery('WELD', crm)).toBe(true);
  });

  it('matches the description and the category', () => {
    expect(matchesAppQuery('deals', crm)).toBe(true);
    expect(matchesAppQuery('marketing', crm)).toBe(true);
    expect(matchesAppQuery('customers', crm)).toBe(true);
  });

  it('needs every word to match, in any field', () => {
    expect(matchesAppQuery('crm sales', crm)).toBe(true);
    expect(matchesAppQuery('crm invoices', crm)).toBe(false);
  });

  it('skips missing fields', () => {
    expect(matchesAppQuery('forms', ['WeldForms', null, undefined, ''])).toBe(true);
    expect(matchesAppQuery('null', ['WeldForms', null])).toBe(false);
  });
});

describe('matchesAppFilters', () => {
  const installedCrm = { isInstalled: true, group: 'Customers' };
  const availableBooks = { isInstalled: false, group: 'Finance' };

  it('passes everything without filters', () => {
    expect(matchesAppFilters([], installedCrm)).toBe(true);
  });

  it('filters on install status', () => {
    const installed = [{ field: 'status', operator: 'is', value: 'installed' }];
    const notInstalled = [{ field: 'status', operator: 'is', value: 'not_installed' }];
    expect(matchesAppFilters(installed, installedCrm)).toBe(true);
    expect(matchesAppFilters(installed, availableBooks)).toBe(false);
    expect(matchesAppFilters(notInstalled, availableBooks)).toBe(true);
  });

  it('filters on category group, and "is not" inverts', () => {
    expect(matchesAppFilters([{ field: 'category', operator: 'is', value: 'Finance' }], availableBooks)).toBe(true);
    expect(matchesAppFilters([{ field: 'category', operator: 'is', value: 'Finance' }], installedCrm)).toBe(false);
    expect(matchesAppFilters([{ field: 'category', operator: 'is not', value: 'Finance' }], installedCrm)).toBe(true);
  });

  it('needs every filter to pass', () => {
    const filters = [
      { field: 'status', operator: 'is', value: 'installed' },
      { field: 'category', operator: 'is', value: 'Finance' },
    ];
    expect(matchesAppFilters(filters, installedCrm)).toBe(false);
    expect(matchesAppFilters(filters, { isInstalled: true, group: 'Finance' })).toBe(true);
  });

  it('ignores pills that are still being built', () => {
    expect(matchesAppFilters([{ field: 'category', operator: '', value: '' }], installedCrm)).toBe(true);
    expect(matchesAppFilters([{ field: 'category', operator: 'is', value: '' }], installedCrm)).toBe(true);
  });
});
