import { resolveActiveEntity, entityStorageKey } from '@/lib/entity';
import type { AccountingEntity } from '@/types/accounting';

const acme: AccountingEntity = {
  id: 'ent_1',
  name: 'Acme',
  jurisdictionCode: 'NL',
  baseCurrency: 'EUR',
  isDefault: true,
  isActive: true,
};

const beta: AccountingEntity = {
  id: 'ent_2',
  name: 'Beta',
  jurisdictionCode: 'BE',
  baseCurrency: 'EUR',
  isDefault: false,
  isActive: true,
};

const archived: AccountingEntity = {
  id: 'ent_old',
  name: 'Archived',
  jurisdictionCode: 'NL',
  baseCurrency: 'EUR',
  isDefault: false,
  isActive: false,
};

describe('resolveActiveEntity', () => {
  it('honours the stored selection when that entity is still active', () => {
    expect(resolveActiveEntity([acme, beta], 'ent_2')).toBe(beta);
  });

  it('falls back to the workspace default when the stored id is gone', () => {
    expect(resolveActiveEntity([acme, beta], 'ent_missing')).toBe(acme);
  });

  it('falls back to the first active entity when nothing is default', () => {
    const noDefault = { ...acme, isDefault: false };
    expect(resolveActiveEntity([noDefault, beta], null)).toBe(noDefault);
  });

  it('skips inactive entities, including a stored selection that was archived', () => {
    expect(resolveActiveEntity([archived, acme, beta], 'ent_old')).toBe(acme);
  });

  it('returns null when the workspace has no active entities', () => {
    expect(resolveActiveEntity([archived], 'ent_old')).toBeNull();
    expect(resolveActiveEntity([], null)).toBeNull();
  });
});

describe('entityStorageKey', () => {
  it('scopes the persisted choice to the Clerk organization', () => {
    expect(entityStorageKey('org_abc')).toBe('@weldbooks/active-entity:org_abc');
  });
});
