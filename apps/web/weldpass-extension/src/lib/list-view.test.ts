import { describe, expect, it } from 'vitest';
import type { WeldPassItem } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { TOTP_FILTER, TOTP_NO, TOTP_YES, VAULT_FILTER, applyListView, isFiltered } from './list-view';

function item(id: string, title: string, overrides: Partial<WeldPassItem> = {}): WeldPassItem {
  return {
    id,
    vaultId: 'vlt_a',
    type: 'login',
    title,
    subtitle: null,
    url: null,
    host: null,
    hasTotp: false,
    passwordChangedAt: null,
    version: 1,
    createdBy: null,
    updatedBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const items = [
  item('1', 'stripe', { vaultId: 'vlt_b', hasTotp: true, updatedAt: '2026-03-01T00:00:00Z' }),
  item('2', 'GitHub', { updatedAt: '2026-05-01T00:00:00Z' }),
  item('3', 'aws', { vaultId: 'vlt_b', updatedAt: '2026-01-01T00:00:00Z' }),
  item('4', 'Figma 10', { hasTotp: true, updatedAt: '2026-04-01T00:00:00Z' }),
  item('5', 'Figma 9', { updatedAt: '2026-02-01T00:00:00Z' }),
];
const ids = (list: WeldPassItem[]) => list.map((entry) => entry.id);
const pill = (field: string, operator: string, value: string) => ({ id: `${field}-${value}`, field, operator, value });

describe('applyListView', () => {
  it('lists by name without a sort, as the platform does', () => {
    expect(ids(applyListView(items, [], null))).toEqual(['3', '4', '5', '2', '1']);
  });

  it('sorts by name, numbers in number order', () => {
    expect(ids(applyListView(items, [], { field: 'name', direction: 'asc' }))).toEqual(['3', '5', '4', '2', '1']);
    expect(ids(applyListView(items, [], { field: 'name', direction: 'desc' }))).toEqual(['1', '2', '4', '5', '3']);
  });

  it('sorts by last update', () => {
    expect(ids(applyListView(items, [], { field: 'updated', direction: 'desc' }))).toEqual(['2', '4', '1', '5', '3']);
    expect(ids(applyListView(items, [], { field: 'updated', direction: 'asc' }))).toEqual(['3', '5', '1', '4', '2']);
  });

  it('filters by vault with is and is not', () => {
    expect(ids(applyListView(items, [pill(VAULT_FILTER, 'is', 'vlt_b')], null))).toEqual(['3', '1']);
    expect(ids(applyListView(items, [pill(VAULT_FILTER, 'is not', 'vlt_b')], null))).toEqual(['4', '5', '2']);
  });

  it('filters by 2FA code', () => {
    expect(ids(applyListView(items, [pill(TOTP_FILTER, 'is', TOTP_YES)], null))).toEqual(['4', '1']);
    expect(ids(applyListView(items, [pill(TOTP_FILTER, 'is', TOTP_NO)], null))).toEqual(['3', '5', '2']);
  });

  it('combines pills', () => {
    const pills = [pill(VAULT_FILTER, 'is', 'vlt_b'), pill(TOTP_FILTER, 'is', TOTP_YES)];
    expect(ids(applyListView(items, pills, null))).toEqual(['1']);
  });

  it('ignores a pill that is still being built', () => {
    expect(ids(applyListView(items, [pill(VAULT_FILTER, 'is', '')], null))).toHaveLength(5);
    expect(isFiltered([pill(VAULT_FILTER, '', '')])).toBe(false);
    expect(isFiltered([pill(VAULT_FILTER, 'is', 'vlt_b')])).toBe(true);
  });

  it('leaves the input alone', () => {
    const copy = [...items];
    applyListView(items, [], { field: 'name', direction: 'asc' });
    expect(items).toEqual(copy);
  });
});
