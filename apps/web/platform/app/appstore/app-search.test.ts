import { describe, expect, it } from 'vitest';
import { matchesAppFilters, matchesAppQuery, userAppMatches } from './app-search';

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

  it('ignores filters on a field the store does not know', () => {
    expect(matchesAppFilters([{ field: 'publisher', operator: 'is', value: 'weldsuite' }], installedCrm)).toBe(true);
  });
});

describe('userAppMatches', () => {
  const timesheets = {
    name: 'Timesheets',
    code: 'timesheets',
    description: 'Log hours against projects',
    category: 'Productivity',
  };

  it('searches the name, code, description and category', () => {
    expect(userAppMatches(timesheets, 'hours', [])).toBe(true);
    expect(userAppMatches(timesheets, 'productivity', [])).toBe(true);
    expect(userAppMatches(timesheets, 'invoices', [])).toBe(false);
  });

  it('filters on its category group', () => {
    expect(userAppMatches(timesheets, '', [{ field: 'category', operator: 'is', value: 'Work' }])).toBe(true);
    expect(userAppMatches(timesheets, '', [{ field: 'category', operator: 'is', value: 'Finance' }])).toBe(false);
  });

  it('reads the install state from either field the API sends', () => {
    const installed = [{ field: 'status', operator: 'is', value: 'installed' }];
    expect(userAppMatches({ ...timesheets, isInstalled: true }, '', installed)).toBe(true);
    expect(userAppMatches({ ...timesheets, installed: true }, '', installed)).toBe(true);
    expect(userAppMatches(timesheets, '', installed)).toBe(false);
  });

  it('copes with an app that has no description or category', () => {
    const bare = { name: 'Notes', code: 'notes', description: null, category: null };
    expect(userAppMatches(bare, 'notes', [{ field: 'status', operator: 'is', value: 'not_installed' }])).toBe(true);
  });
});
