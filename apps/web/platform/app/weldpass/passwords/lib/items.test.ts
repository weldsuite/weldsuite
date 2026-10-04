import { describe, expect, it } from 'vitest';
import type {
  WeldPassItem,
  WeldPassVault,
  WeldPassVaultRole,
} from '@weldsuite/app-api-client/domains/weldpass-passwords';
import {
  canAdministerVault,
  canEditVault,
  countByVault,
  createItemFormSchema,
  defaultCreateVaultId,
  emptyItemForm,
  filterItems,
  formatTotpCode,
  isNonMemberView,
  itemToFormValues,
  moveTargets,
  safeHref,
  secondsUntil,
  sortVaults,
  toItemInput,
} from './items';

function item(overrides: Partial<WeldPassItem>): WeldPassItem {
  return {
    id: 'i1',
    vaultId: 'v1',
    type: 'login',
    title: 'Example',
    subtitle: null,
    url: null,
    host: null,
    hasTotp: false,
    passwordChangedAt: null,
    version: 1,
    createdBy: null,
    updatedBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function vault(
  id: string,
  role: WeldPassVaultRole | null,
  overrides: Partial<WeldPassVault> = {},
): WeldPassVault {
  return {
    id,
    kind: 'shared',
    ownerId: null,
    name: id,
    description: null,
    createdBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    role,
    ...overrides,
  };
}

describe('filterItems', () => {
  const items = [
    item({ id: 'a', title: 'GitHub', subtitle: 'dev@acme.com', host: 'github.com', vaultId: 'v1' }),
    item({ id: 'b', title: 'Bank card', type: 'card', subtitle: '•••• 4242', vaultId: 'v2' }),
    item({ id: 'c', title: 'Wifi code', type: 'note', vaultId: 'v1' }),
    item({ id: 'd', title: 'AWS', url: 'https://console.aws.amazon.com', host: 'aws.amazon.com' }),
  ];

  it('returns everything, sorted by title, with no filter', () => {
    expect(filterItems(items, {}).map((i) => i.id)).toEqual(['d', 'b', 'a', 'c']);
  });

  it('filters by vault', () => {
    expect(filterItems(items, { vaultId: 'v2' }).map((i) => i.id)).toEqual(['b']);
  });

  it('treats a null or missing vault as all vaults', () => {
    expect(filterItems(items, { vaultId: null })).toHaveLength(4);
  });

  it('filters by type, and "all" keeps every type', () => {
    expect(filterItems(items, { type: 'note' }).map((i) => i.id)).toEqual(['c']);
    expect(filterItems(items, { type: 'all' })).toHaveLength(4);
  });

  it('matches title, username, host and url case-insensitively', () => {
    expect(filterItems(items, { query: 'GITHUB' }).map((i) => i.id)).toEqual(['a']);
    expect(filterItems(items, { query: 'dev@acme' }).map((i) => i.id)).toEqual(['a']);
    expect(filterItems(items, { query: 'amazon' }).map((i) => i.id)).toEqual(['d']);
    expect(filterItems(items, { query: '4242' }).map((i) => i.id)).toEqual(['b']);
  });

  it('requires every word of the query to match', () => {
    expect(filterItems(items, { query: 'github acme' }).map((i) => i.id)).toEqual(['a']);
    expect(filterItems(items, { query: 'github bank' })).toEqual([]);
  });

  it('ignores a blank query', () => {
    expect(filterItems(items, { query: '   ' })).toHaveLength(4);
  });

  it('combines vault, type and query', () => {
    expect(filterItems(items, { vaultId: 'v1', type: 'login', query: 'git' }).map((i) => i.id)).toEqual(
      ['a'],
    );
  });

  it('does not mutate the input', () => {
    const copy = [...items];
    filterItems(items, {});
    expect(items).toEqual(copy);
  });
});

describe('countByVault', () => {
  it('counts items per vault', () => {
    const counts = countByVault([
      item({ vaultId: 'v1' }),
      item({ vaultId: 'v1' }),
      item({ vaultId: 'v2' }),
    ]);
    expect(counts.get('v1')).toBe(2);
    expect(counts.get('v2')).toBe(1);
    expect(counts.get('v3')).toBeUndefined();
  });
});

describe('vault roles', () => {
  it('lets editors and managers write, but not viewers or non-members', () => {
    expect(canEditVault(vault('a', 'viewer'))).toBe(false);
    expect(canEditVault(vault('a', 'editor'))).toBe(true);
    expect(canEditVault(vault('a', 'manager'))).toBe(true);
    expect(canEditVault(vault('a', null))).toBe(false);
    expect(canEditVault(undefined)).toBe(false);
  });

  it('lets a manager or a workspace admin administer a shared vault', () => {
    expect(canAdministerVault(vault('a', 'manager'), false)).toBe(true);
    expect(canAdministerVault(vault('a', 'editor'), false)).toBe(false);
    expect(canAdministerVault(vault('a', null), false)).toBe(false);
    expect(canAdministerVault(vault('a', null), true)).toBe(true);
    expect(canAdministerVault(vault('a', 'viewer'), true)).toBe(true);
  });

  it('never lets anyone administer a personal vault', () => {
    expect(canAdministerVault(vault('p', 'manager', { kind: 'personal' }), true)).toBe(false);
  });

  it('recognises the admin-not-a-member view', () => {
    expect(isNonMemberView(vault('a', null))).toBe(true);
    expect(isNonMemberView(vault('a', 'viewer'))).toBe(false);
    expect(isNonMemberView(undefined)).toBe(false);
  });

  it('sorts the personal vault first, then shared vaults by name', () => {
    const sorted = sortVaults([
      vault('z', 'editor', { name: 'Zeta' }),
      vault('p', 'manager', { kind: 'personal', name: 'Whatever' }),
      vault('a', 'editor', { name: 'alpha' }),
    ]);
    expect(sorted.map((v) => v.id)).toEqual(['p', 'a', 'z']);
  });
});

describe('moveTargets', () => {
  const vaults = [
    vault('p', 'manager', { kind: 'personal' }),
    vault('ed', 'editor'),
    vault('view', 'viewer'),
    vault('admin', null),
    vault('mgr', 'manager'),
  ];

  it('offers only vaults the caller can edit, minus the current one', () => {
    expect(moveTargets(vaults, 'p').map((v) => v.id)).toEqual(['ed', 'mgr']);
    expect(moveTargets(vaults, 'ed').map((v) => v.id)).toEqual(['p', 'mgr']);
  });
});

describe('defaultCreateVaultId', () => {
  const vaults = [
    vault('p', 'manager', { kind: 'personal' }),
    vault('ed', 'editor'),
    vault('view', 'viewer'),
  ];

  it('prefers the selected vault when it is writable', () => {
    expect(defaultCreateVaultId(vaults, 'ed')).toBe('ed');
  });

  it('falls back to the personal vault for a read-only or unknown selection', () => {
    expect(defaultCreateVaultId(vaults, 'view')).toBe('p');
    expect(defaultCreateVaultId(vaults, 'nope')).toBe('p');
    expect(defaultCreateVaultId(vaults, null)).toBe('p');
  });

  it('falls back to the first writable vault without a personal one', () => {
    expect(defaultCreateVaultId([vault('view', 'viewer'), vault('ed', 'editor')], null)).toBe('ed');
  });

  it('returns undefined when nothing is writable', () => {
    expect(defaultCreateVaultId([vault('view', 'viewer')], null)).toBeUndefined();
  });
});

describe('two-factor helpers', () => {
  it('counts whole seconds up to the expiry and never goes negative', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    expect(secondsUntil('2026-01-01T00:00:12.200Z', now)).toBe(13);
    expect(secondsUntil('2026-01-01T00:00:00.000Z', now)).toBe(0);
    expect(secondsUntil('2025-12-31T23:59:00.000Z', now)).toBe(0);
    expect(secondsUntil('not a date', now)).toBe(0);
  });

  it('groups a code for reading', () => {
    expect(formatTotpCode('123456')).toBe('123 456');
    expect(formatTotpCode('12345678')).toBe('1234 5678');
    expect(formatTotpCode('123')).toBe('123');
  });
});

describe('item form', () => {
  const schema = createItemFormSchema({ titleRequired: 'Title is required' });

  it('requires a title and reports the translated message', () => {
    const result = schema.safeParse(emptyItemForm('login', 'v1'));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].message).toBe('Title is required');
  });

  it('accepts an empty login apart from the title', () => {
    const values = { ...emptyItemForm('login', 'v1'), title: 'Acme' };
    expect(schema.safeParse(values).success).toBe(true);
  });

  it('builds a login with only login fields and a null URL when blank', () => {
    const input = toItemInput({
      ...emptyItemForm('login', 'v1'),
      title: ' Acme ',
      username: 'me',
      password: 'secret',
      cardholder: 'Left over',
    });
    expect(input).toEqual({
      type: 'login',
      title: 'Acme',
      url: null,
      fields: { username: 'me', password: 'secret', totp: '', notes: '' },
    });
  });

  it('builds a note and a card', () => {
    expect(toItemInput({ ...emptyItemForm('note', 'v1'), title: 'N', content: 'hello' })).toEqual({
      type: 'note',
      title: 'N',
      fields: { content: 'hello' },
    });
    expect(
      toItemInput({ ...emptyItemForm('card', 'v1'), title: 'C', number: '4242', expiry: '08/29' }),
    ).toEqual({
      type: 'card',
      title: 'C',
      fields: { cardholder: '', number: '4242', expiry: '08/29', cvc: '', notes: '' },
    });
  });

  it('round-trips a revealed login through the form', () => {
    const fields = { username: 'me', password: 'pw', totp: 'JBSWY3DPEHPK3PXP', notes: 'n' };
    const values = itemToFormValues(
      { type: 'login', vaultId: 'v9', title: 'Acme', url: 'https://acme.test' },
      fields,
    );
    expect(values.vaultId).toBe('v9');
    expect(toItemInput(values)).toEqual({
      type: 'login',
      title: 'Acme',
      url: 'https://acme.test',
      fields,
    });
  });

  it('prefills a note and a card', () => {
    const note = itemToFormValues(
      { type: 'note', vaultId: 'v1', title: 'N', url: null },
      { content: 'text' },
    );
    expect(note.content).toBe('text');

    const card = itemToFormValues(
      { type: 'card', vaultId: 'v1', title: 'C', url: null },
      { cardholder: 'A B', number: '4242', expiry: '08/29', cvc: '123', notes: '' },
    );
    expect(card.cardholder).toBe('A B');
    expect(card.cvc).toBe('123');
  });
});

describe('safeHref', () => {
  it('adds https to a bare host and keeps http(s) URLs', () => {
    expect(safeHref('example.com/login')).toBe('https://example.com/login');
    expect(safeHref('http://example.com')).toBe('http://example.com/');
  });

  it('refuses other schemes and blanks', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('ftp://example.com')).toBeNull();
    expect(safeHref('   ')).toBeNull();
    expect(safeHref(null)).toBeNull();
  });
});
