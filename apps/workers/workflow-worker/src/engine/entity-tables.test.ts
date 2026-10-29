import { describe, it, expect } from 'vitest';
import { assertNoMailAccountCredentialWrite, getEntityColumns, getEntityTable } from './entity-tables';
import { schema } from '../db';

describe('entity tables never expose ciphertext columns', () => {
  it('projects ciphertext out of a table that has it', () => {
    const parties = getEntityColumns(schema.parties);
    expect(parties).toBeDefined();
    expect('sensitiveEncrypted' in parties!).toBe(false);
    expect('tinLast4' in parties!).toBe(true);

    expect('ssnEncrypted' in getEntityColumns(schema.entities)!).toBe(false);
    expect('accountNumberEncrypted' in getEntityColumns(schema.bankAccounts)!).toBe(false);
  });

  it('projects a mail account\'s credentials out too', () => {
    const columns = getEntityColumns(schema.mailAccounts);
    expect(columns).toBeDefined();
    expect('accessToken' in columns!).toBe(false);
    expect('refreshToken' in columns!).toBe(false);
    expect('apiKey' in columns!).toBe(false);
    expect('passwordHash' in columns!).toBe(false);
    expect('providerConfig' in columns!).toBe(false);
    expect('isShared' in columns!).toBe(true);
  });

  it('selects everything from a table with none', () => {
    expect(getEntityColumns(schema.companies)).toBeUndefined();
  });

  it('does not map the WeldBooks counterparty, entity or bank account tables to a record type', () => {
    for (const type of ['party', 'accounting_contact', 'entity', 'accounting_entity', 'bank_account']) {
      expect(() => getEntityTable(type), type).toThrow(/Unknown entity type/);
    }
  });
});

describe('a mail account\'s credentials are never generic-CRUD writable', () => {
  it('refuses a create/update payload that sets any credential column', () => {
    for (const key of ['accessToken', 'refreshToken', 'apiKey', 'passwordHash', 'providerConfig']) {
      expect(() => assertNoMailAccountCredentialWrite('mail_account', { [key]: 'x' }), key).toThrow(
        new RegExp(key),
      );
    }
  });

  it('allows a payload with none of them', () => {
    expect(() =>
      assertNoMailAccountCredentialWrite('mail_account', { name: 'Support', isShared: true }),
    ).not.toThrow();
  });

  it('is a no-op for every other entity type, credentials or not', () => {
    expect(() =>
      assertNoMailAccountCredentialWrite('mail_message', { accessToken: 'x' }),
    ).not.toThrow();
  });
});
