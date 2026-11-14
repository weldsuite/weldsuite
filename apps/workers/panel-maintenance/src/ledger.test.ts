import { describe, expect, it } from 'vitest';
import { newLedger } from './testing/fakes';

const T1 = new Date('2026-11-10T10:00:00.000Z');
const T2 = new Date('2026-11-12T10:00:00.000Z');

describe('MaintenanceLedger', () => {
  it('records the ids of an erasure, once each, and groups what waits by project', async () => {
    const ledger = newLedger();
    expect(await ledger.addErasure({ workspaceId: 'ws_a', projectId: 'pnp_1', ids: ['u1', 'ck_1', 'u1'] }, T1)).toBe(2);
    await ledger.addErasure({ workspaceId: 'ws_b', projectId: 'pnp_2', ids: ['u9'] }, T2);

    expect(await ledger.pending()).toEqual([
      { workspaceId: 'ws_a', projectId: 'pnp_1', ids: ['ck_1', 'u1'], oldest: T1.toISOString() },
      { workspaceId: 'ws_b', projectId: 'pnp_2', ids: ['u9'], oldest: T2.toISOString() },
    ]);
  });

  it('keeps the same id in two projects apart', async () => {
    const ledger = newLedger();
    await ledger.addErasure({ workspaceId: 'ws_a', projectId: 'pnp_1', ids: ['u1'] }, T1);
    await ledger.addErasure({ workspaceId: 'ws_a', projectId: 'pnp_2', ids: ['u1'] }, T1);
    expect((await ledger.pending()).map((p) => p.projectId)).toEqual(['pnp_1', 'pnp_2']);
  });

  it('gives an id that is queued again the new time, so a run that began before it does not take it', async () => {
    const ledger = newLedger();
    await ledger.addErasure({ workspaceId: 'ws_a', projectId: 'pnp_1', ids: ['u1', 'u2'] }, T1);
    await ledger.addErasure({ workspaceId: 'ws_a', projectId: 'pnp_1', ids: ['u2'] }, T2);

    // A run planned between the two: u1 was covered, u2 came back after it.
    const planned = '2026-11-11T00:00:00.000Z';
    expect(await ledger.settled('pnp_1', ['u1', 'u2'], planned)).toEqual(['u1']);
    expect(await ledger.settled('pnp_1', ['u1', 'u2'], '2026-11-13T00:00:00.000Z')).toEqual(['u1', 'u2']);
  });

  it('ignores ids it does not hold and ids of another project when asked what a run covered', async () => {
    const ledger = newLedger();
    await ledger.addErasure({ workspaceId: 'ws_a', projectId: 'pnp_1', ids: ['u1'] }, T1);
    expect(await ledger.settled('pnp_1', ['nobody'], T2.toISOString())).toEqual([]);
    expect(await ledger.settled('pnp_2', ['u1'], T2.toISOString())).toEqual([]);
  });

  it('forgets completed ids and keeps the rest', async () => {
    const ledger = newLedger();
    await ledger.addErasure({ workspaceId: 'ws_a', projectId: 'pnp_1', ids: ['u1', 'u2', 'u3'] }, T1);
    await ledger.complete('pnp_1', ['u1', 'u3', 'never-there']);

    expect(await ledger.pending()).toEqual([{ workspaceId: 'ws_a', projectId: 'pnp_1', ids: ['u2'], oldest: T1.toISOString() }]);
    await ledger.complete('pnp_1', ['u2']);
    expect(await ledger.pending()).toEqual([]);
  });

  it('keeps a record of the runs, newest first', async () => {
    const ledger = newLedger();
    await ledger.recordRun({ runId: 'maintenance-2026-11-01', finishedAt: '2026-11-01T03:20:00.000Z', erasedIds: 3, summary: '{}' });
    await ledger.recordRun({ runId: 'maintenance-2026-11-08', finishedAt: '2026-11-08T03:25:00.000Z', erasedIds: 0, summary: '{"a":1}' });

    expect((await ledger.runs()).map((r) => r.runId)).toEqual(['maintenance-2026-11-08', 'maintenance-2026-11-01']);
    expect(await ledger.runs(1)).toHaveLength(1);
  });
});
