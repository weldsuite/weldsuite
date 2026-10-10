import { describe, it, expect } from 'vitest';
import type { PartnerStatementView } from '@weldsuite/app-api-client/schemas/partners';
import { PartnerPortalError, removeTeamMember, statementToCsv, updateTeamMemberRole } from './portal';

const line = (over: Partial<PartnerStatementView['lines'][number]> = {}) => ({
  workspaceId: 'ws_1',
  workspaceName: 'Acme',
  daysActive: 31,
  daysInPeriod: 31,
  seatsBilled: 5,
  resale: '199.00',
  shareAmount: '149.25',
  floorAmount: '50.00',
  creditFloorAmount: '0.00',
  extraCreditsAmount: '0.00',
  due: '149.25',
  margin: '49.75',
  ...over,
});

const view = (lines: PartnerStatementView['lines']): PartnerStatementView => ({
  id: null,
  periodStart: '2026-10-01T00:00:00.000Z',
  periodEnd: '2026-11-01T00:00:00.000Z',
  currency: 'USD',
  status: 'preview',
  totalResale: '0.00',
  totalDue: '0.00',
  totalMargin: '0.00',
  stripeInvoiceUrl: null,
  stripeInvoicePdf: null,
  dueAt: null,
  paidAt: null,
  lines,
});

describe('statementToCsv', () => {
  it('has a header and one row per line', () => {
    const rows = statementToCsv(view([line(), line({ workspaceId: 'ws_2', workspaceName: 'Beta' })])).trim().split('\r\n');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe(
      'Workspace,Workspace ID,Days active,Days in period,Seats billed,Customer price,WeldSuite share,Floor,Credit floor,Extra credits,WeldSuite bills,Your margin',
    );
    expect(rows[1]).toBe('Acme,ws_1,31,31,5,199.00,149.25,50.00,0.00,0.00,149.25,49.75');
  });

  it('is only the header for a statement without lines', () => {
    expect(statementToCsv(view([])).trim().split('\r\n')).toHaveLength(1);
  });

  it('quotes commas and quotes in names', () => {
    const csv = statementToCsv(view([line({ workspaceName: 'Acme, "Inc"' })]));
    expect(csv).toContain('"Acme, ""Inc""",ws_1');
  });

  it('neutralises names a spreadsheet would run as a formula, but keeps negative amounts numeric', () => {
    const csv = statementToCsv(view([line({ workspaceName: '=HYPERLINK("http://x")', margin: '-50.00' })]));
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv.trim().split('\r\n')[1]!.endsWith(',-50.00')).toBe(true);
  });
});

/** A db whose every `select().from().where()[.limit()]` resolves the next queued result set. */
function fakeDb(...results: unknown[][]) {
  const queue = [...results];
  const writes: string[] = [];
  const next = () => Promise.resolve(queue.shift() ?? []);
  const db = {
    select: () => db,
    from: () => db,
    // Lazy: `await where()` and `where().limit()` each consume one result set.
    where: () => ({
      limit: next,
      then: (resolve: (rows: unknown[]) => unknown, reject: (e: unknown) => unknown) => next().then(resolve, reject),
    }),
    update: () => ({ set: () => ({ where: () => ({ returning: () => (writes.push('update'), Promise.resolve([{ id: 'ptm_1', role: 'admin', email: 'a@b.c', userId: 'u', acceptedAt: null }])) }) }) }),
    delete: () => ({ where: () => (writes.push('delete'), Promise.resolve()) }),
  };
  return { db, writes };
}

const owner = { id: 'ptm_1', partnerId: 'ptr_1', role: 'owner', email: 'o@p.test', userId: 'u1', acceptedAt: null };

describe('last owner rule', () => {
  it('refuses to demote the last owner', async () => {
    const { db, writes } = fakeDb([owner], [{ n: 0 }]);
    await expect(updateTeamMemberRole(db, 'ptr_1', 'ptm_1', 'admin')).rejects.toMatchObject({ code: 'LAST_OWNER' });
    expect(writes).toEqual([]);
  });

  it('demotes an owner when another active owner remains', async () => {
    const { db, writes } = fakeDb([owner], [{ n: 1 }]);
    await expect(updateTeamMemberRole(db, 'ptr_1', 'ptm_1', 'admin')).resolves.toMatchObject({ role: 'admin' });
    expect(writes).toEqual(['update']);
  });

  it('does not count the owner rule for other roles', async () => {
    const { db } = fakeDb([{ ...owner, role: 'viewer' }]);
    await expect(updateTeamMemberRole(db, 'ptr_1', 'ptm_1', 'admin')).resolves.toBeTruthy();
  });

  it('refuses to remove the last owner', async () => {
    const { db, writes } = fakeDb([owner], [{ n: 0 }]);
    await expect(removeTeamMember(db, 'ptr_1', 'ptm_1')).rejects.toBeInstanceOf(PartnerPortalError);
    expect(writes).toEqual([]);
  });

  it('removes a member who is not the last owner', async () => {
    const { db, writes } = fakeDb([{ ...owner, role: 'admin' }]);
    await expect(removeTeamMember(db, 'ptr_1', 'ptm_1')).resolves.toBe(true);
    expect(writes).toEqual(['delete']);
  });

  it('returns null / false for a member of another partner', async () => {
    expect(await updateTeamMemberRole(fakeDb([]).db, 'ptr_1', 'ptm_x', 'admin')).toBeNull();
    expect(await removeTeamMember(fakeDb([]).db, 'ptr_1', 'ptm_x')).toBe(false);
  });
});
