import { describe, it, expect } from 'vitest';
import { getEntityColumns, getEntityTable } from './entity-tables';
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

  it('selects everything from a table with none', () => {
    expect(getEntityColumns(schema.companies)).toBeUndefined();
  });

  it('does not map the WeldBooks counterparty, entity or bank account tables to a record type', () => {
    for (const type of ['party', 'accounting_contact', 'entity', 'accounting_entity', 'bank_account']) {
      expect(() => getEntityTable(type), type).toThrow(/Unknown entity type/);
    }
  });
});
