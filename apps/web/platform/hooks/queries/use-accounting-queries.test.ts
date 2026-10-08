import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

vi.mock('@/lib/api/domains/weldbooks', () => ({ accountingApi: {} }));

import {
  accountingKeys,
  isEntityScopedAccountingQuery,
  resetEntityScopedAccountingQueries,
} from './use-accounting-queries';

describe('isEntityScopedAccountingQuery', () => {
  it('treats per-entity data as entity scoped', () => {
    expect(isEntityScopedAccountingQuery(accountingKeys.invoices.list({ status: 'draft' }))).toBe(true);
    expect(isEntityScopedAccountingQuery(accountingKeys.dashboard())).toBe(true);
    expect(isEntityScopedAccountingQuery(['accounting', 'reports', 'profit-loss', {}])).toBe(true);
  });

  it('keeps entity rows and jurisdictions', () => {
    expect(isEntityScopedAccountingQuery(['accounting', 'entities', 'ws_1'])).toBe(false);
    expect(isEntityScopedAccountingQuery(accountingKeys.entities.detail('ent_1'))).toBe(false);
    expect(isEntityScopedAccountingQuery(accountingKeys.jurisdictions())).toBe(false);
    expect(isEntityScopedAccountingQuery(['crm', 'companies'])).toBe(false);
  });
});

describe('resetEntityScopedAccountingQueries', () => {
  it("drops the previous entity's data but keeps the entity list", async () => {
    const qc = new QueryClient();
    qc.setQueryData(accountingKeys.invoices.list(), { data: [{ id: 'inv_nl' }] });
    qc.setQueryData(['accounting', 'entities', 'ws_1'], [{ id: 'ent_nl' }, { id: 'ent_us' }]);

    await resetEntityScopedAccountingQueries(qc);

    expect(qc.getQueryData(accountingKeys.invoices.list())).toBeUndefined();
    expect(qc.getQueryData(['accounting', 'entities', 'ws_1'])).toEqual([{ id: 'ent_nl' }, { id: 'ent_us' }]);
  });
});
