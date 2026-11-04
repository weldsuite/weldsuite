/**
 * The database half of the approvals core, against a real Postgres (pglite).
 *
 * `flow_approvals` and `flow_approval_delegations` come with the schema in
 * `@weldsuite/db`, but their migration is generated once at integration time
 * (FLOW foundation), so until then pglite's migrated tenant database does not
 * have them. `ensureTables` creates them from the DDL below when they are
 * missing, and a test compares the columns with the Drizzle schema so the DDL
 * cannot drift from it. Once the migration exists the `if not exists` is a
 * no-op and the same tests run against the migrated tables.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getTableColumns, sql } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  cancelPendingApprovals,
  decideApproval,
  findActiveDelegation,
  listPendingForApprover,
  listSubjectApprovals,
  registerApprovalSubject,
  requestApprovals,
  resolveApprovalSubject,
  unregisterApprovalSubject,
  type ApprovalRow,
  type ApprovalRowInput,
  type ApprovalSubjectHandler,
  type ResolvedApprovalOutcome,
} from './approvals';

const DDL = [
  `create table if not exists flow_approvals (
    id varchar(30) primary key not null,
    project_id varchar(255),
    subject_type varchar(30) not null,
    subject_id varchar(255) not null,
    approver_kind varchar(10) not null default 'member',
    approver_id varchar(255) not null,
    role_label varchar(100),
    step integer not null default 1,
    rule jsonb not null,
    decision varchar(30) not null default 'pending',
    note text,
    due_at timestamptz,
    decided_at timestamptz,
    decided_by varchar(255),
    delegated_from varchar(255),
    reminded_at timestamptz,
    overdue_notified_at timestamptz,
    created_by varchar(255) not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz,
    constraint flow_approvals_subject_type_check check (subject_type in ('change_request', 'gate', 'deliverable', 'decision', 'risk_acceptance', 'project_request', 'project_close')),
    constraint flow_approvals_approver_kind_check check (approver_kind in ('member', 'contact')),
    constraint flow_approvals_decision_check check (decision in ('pending', 'approved', 'approved_with_conditions', 'rejected', 'info_requested')),
    constraint flow_approvals_step_check check (step >= 1)
  )`,
  `create index if not exists flow_approvals_approver_decision_due_idx on flow_approvals (approver_id, decision, due_at)`,
  `create index if not exists flow_approvals_subject_idx on flow_approvals (subject_type, subject_id)`,
  `create table if not exists flow_approval_delegations (
    id varchar(30) primary key not null,
    member_id varchar(255) not null,
    delegate_id varchar(255) not null,
    starts_at timestamptz not null,
    ends_at timestamptz not null,
    created_by varchar(255) not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz,
    constraint flow_approval_delegations_period_check check (ends_at > starts_at),
    constraint flow_approval_delegations_self_check check (member_id <> delegate_id)
  )`,
];

const NOW = new Date('2026-11-04T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const rule = { code: 'change_board_over_limit' };

let db: Database;
let close: () => Promise<void>;

async function seedDelegation(memberId: string, delegateId: string, startsAt: Date, endsAt: Date, deletedAt: Date | null = null) {
  await db.insert(schema.flowApprovalDelegations).values({
    id: `dlg_${memberId}_${delegateId}_${startsAt.getTime()}`,
    memberId,
    delegateId,
    startsAt,
    endsAt,
    deletedAt,
    createdBy: memberId,
  });
}

/** Ask for approvals and return the rows, failing the test when the request is refused. */
async function ask(
  subjectId: string,
  rows: ApprovalRowInput[],
  subjectType: Parameters<typeof requestApprovals>[1]['subjectType'] = 'change_request',
): Promise<ApprovalRow[]> {
  const result = await requestApprovals(db, {
    projectId: null,
    subjectType,
    subjectId,
    requestedBy: 'requester',
    rows,
    now: NOW,
  });
  if (!result.ok) throw new Error(result.message);
  return result.rows;
}

beforeAll(async () => {
  ({ db, close } = await createPgliteDb());
  for (const statement of DDL) await db.execute(sql.raw(statement));
}, 120_000);

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await db.execute(sql.raw('delete from flow_approvals'));
  await db.execute(sql.raw('delete from flow_approval_delegations'));
});

afterEach(() => {
  unregisterApprovalSubject('change_request');
  unregisterApprovalSubject('gate');
});

describe('schema', () => {
  it('has every column of the Drizzle tables', async () => {
    for (const [name, table] of [
      ['flow_approvals', schema.flowApprovals],
      ['flow_approval_delegations', schema.flowApprovalDelegations],
    ] as const) {
      const result = await db.execute(
        sql`select column_name from information_schema.columns where table_name = ${name}`,
      );
      const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Array<{ column_name: string }>;
      const inDb = rows.map((r) => r.column_name).sort();
      const inSchema = Object.values(getTableColumns(table))
        .map((column) => column.name)
        .sort();
      expect(inDb, name).toEqual(inSchema);
    }
  });
});

describe('requestApprovals', () => {
  it('creates one pending row per approver, with the rule, step and due date', async () => {
    const due = new Date(NOW.getTime() + 3 * DAY);
    const rows = await ask('cr_1', [
      { approverId: 'u1', rule, roleLabel: 'Finance', dueAt: due },
      { approverId: 'u2', rule, step: 2 },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      subjectType: 'change_request',
      subjectId: 'cr_1',
      approverKind: 'member',
      approverId: 'u1',
      roleLabel: 'Finance',
      step: 1,
      rule,
      decision: 'pending',
      createdBy: 'requester',
      delegatedFrom: null,
      decidedAt: null,
      deletedAt: null,
    });
    expect(rows[0]!.dueAt?.toISOString()).toBe(due.toISOString());
    expect(rows[1]).toMatchObject({ approverId: 'u2', step: 2 });
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    expect(rows[0]!.id).toMatch(/^apr_/);
  });

  it('routes a member on delegation to the delegate, who is asked once', async () => {
    await seedDelegation('u1', 'u9', new Date(NOW.getTime() - DAY), new Date(NOW.getTime() + DAY));
    const rows = await ask('cr_1', [
      { approverId: 'u1', rule },
      { approverId: 'u9', rule },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ approverId: 'u9', delegatedFrom: 'u1' });
  });

  it('does not use a delegation that has ended or was deleted', async () => {
    await seedDelegation('u1', 'u8', new Date(NOW.getTime() - 3 * DAY), new Date(NOW.getTime() - DAY));
    await seedDelegation('u1', 'u9', new Date(NOW.getTime() - DAY), new Date(NOW.getTime() + DAY), new Date(NOW));
    const [only] = await ask('cr_1', [{ approverId: 'u1', rule }]);
    expect(only).toMatchObject({ approverId: 'u1', delegatedFrom: null });
  });

  it('refuses an invalid request and a subject that already has approvals', async () => {
    const empty = await requestApprovals(db, {
      projectId: null,
      subjectType: 'gate',
      subjectId: 'ph_1',
      requestedBy: 'requester',
      rows: [],
      now: NOW,
    });
    expect(empty).toMatchObject({ ok: false, code: 'invalid' });

    await ask('cr_1', [{ approverId: 'u1', rule }]);
    const again = await requestApprovals(db, {
      projectId: null,
      subjectType: 'change_request',
      subjectId: 'cr_1',
      requestedBy: 'requester',
      rows: [{ approverId: 'u2', rule }],
      now: NOW,
    });
    expect(again).toMatchObject({ ok: false, code: 'already_requested' });
  });

  it('lets a subject be requested again once its rows are cleared', async () => {
    await ask('cr_1', [{ approverId: 'u1', rule }]);
    await cancelPendingApprovals(db, { subjectType: 'change_request', subjectId: 'cr_1', now: NOW });
    const rows = await ask('cr_1', [{ approverId: 'u2', rule }]);
    expect(rows).toHaveLength(1);
    expect(await listSubjectApprovals(db, 'change_request', 'cr_1')).toHaveLength(1);
  });
});

describe('decideApproval', () => {
  it('stores the answer of the approver and settles a single-approver subject', async () => {
    const [row] = await ask('cr_1', [{ approverId: 'u1', rule: { code: 'change_manager' } }]);
    const result = await decideApproval(db, { approvalId: row!.id, actor: 'u1', decision: 'approved', note: ' ok ', now: NOW });
    expect(result).toMatchObject({ ok: true, outcome: 'approved', resolved: true, viaDelegation: false });
    if (!result.ok) return;
    expect(result.approval).toMatchObject({
      decision: 'approved',
      note: 'ok',
      decidedBy: 'u1',
    });
    expect(result.approval.decidedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it('refuses an unknown row, someone who is not the approver, and a contact posing as a member', async () => {
    const [row] = await ask('cr_1', [{ approverId: 'u1', rule }]);
    expect(await decideApproval(db, { approvalId: 'apr_missing', actor: 'u1', decision: 'approved' })).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(await decideApproval(db, { approvalId: row!.id, actor: 'u2', decision: 'approved' })).toMatchObject({
      ok: false,
      code: 'not_approver',
    });
    expect(
      await decideApproval(db, { approvalId: row!.id, actor: { kind: 'contact', id: 'u1' }, decision: 'approved' }),
    ).toMatchObject({ ok: false, code: 'not_approver' });
    // Nothing was stored.
    expect((await listSubjectApprovals(db, 'change_request', 'cr_1'))[0]!.decision).toBe('pending');
  });

  it('lets an active delegate answer for the approver, and records who did', async () => {
    const [row] = await ask('cr_1', [{ approverId: 'u1', rule }]);
    await seedDelegation('u1', 'u9', new Date(NOW.getTime() - DAY), new Date(NOW.getTime() + DAY));
    const result = await decideApproval(db, { approvalId: row!.id, actor: 'u9', decision: 'approved', now: NOW });
    expect(result).toMatchObject({ ok: true, viaDelegation: true });
    if (!result.ok) return;
    expect(result.approval).toMatchObject({ approverId: 'u1', decidedBy: 'u9' });
  });

  it('does not let a delegate answer before the delegation starts or after it ends', async () => {
    const [row] = await ask('cr_1', [{ approverId: 'u1', rule }]);
    await seedDelegation('u1', 'u9', new Date(NOW.getTime() + DAY), new Date(NOW.getTime() + 2 * DAY));
    expect(await decideApproval(db, { approvalId: row!.id, actor: 'u9', decision: 'approved', now: NOW })).toMatchObject({
      ok: false,
      code: 'not_approver',
    });
    expect(
      await decideApproval(db, { approvalId: row!.id, actor: 'u9', decision: 'approved', now: new Date(NOW.getTime() + 2 * DAY) }),
    ).toMatchObject({ ok: false, code: 'not_approver' });
  });

  it('keeps a row asked of a delegate answerable by the member after the delegation ended', async () => {
    await seedDelegation('u1', 'u9', new Date(NOW.getTime() - DAY), new Date(NOW.getTime() + DAY));
    const [row] = await ask('cr_1', [{ approverId: 'u1', rule }]);
    expect(row).toMatchObject({ approverId: 'u9', delegatedFrom: 'u1' });
    // Two days on the delegation is over: the member is still an approver of the row.
    const later = new Date(NOW.getTime() + 2 * DAY);
    const result = await decideApproval(db, { approvalId: row!.id, actor: 'u1', decision: 'approved', now: later });
    expect(result).toMatchObject({ ok: true, viaDelegation: false });
    // A stranger still cannot.
    const [other] = await ask('cr_2', [{ approverId: 'u1', rule }]);
    expect(await decideApproval(db, { approvalId: other!.id, actor: 'u5', decision: 'approved', now: later })).toMatchObject({
      ok: false,
      code: 'not_approver',
    });
  });

  it('needs a note to decline and to set conditions, and stores nothing when it is missing', async () => {
    const [row] = await ask('cr_1', [{ approverId: 'u1', rule }]);
    expect(await decideApproval(db, { approvalId: row!.id, actor: 'u1', decision: 'rejected' })).toMatchObject({
      ok: false,
      code: 'note_required',
    });
    expect(
      await decideApproval(db, { approvalId: row!.id, actor: 'u1', decision: 'approved_with_conditions', note: ' ' }),
    ).toMatchObject({ ok: false, code: 'note_required' });
    expect(await decideApproval(db, { approvalId: row!.id, actor: 'u1', decision: 'pending' })).toMatchObject({
      ok: false,
      code: 'invalid_decision',
    });
    expect((await listSubjectApprovals(db, 'change_request', 'cr_1'))[0]!.decision).toBe('pending');
  });

  it('refuses an answered row, and a second answer at the same time loses', async () => {
    const [row] = await ask('cr_1', [{ approverId: 'u1', rule }, { approverId: 'u2', rule }]);
    const first = await decideApproval(db, { approvalId: row!.id, actor: 'u1', decision: 'approved' });
    expect(first).toMatchObject({ ok: true, outcome: 'pending', resolved: false });
    expect(await decideApproval(db, { approvalId: row!.id, actor: 'u1', decision: 'rejected', note: 'changed my mind' })).toMatchObject({
      ok: false,
      code: 'already_decided',
    });

    const [other] = (await listSubjectApprovals(db, 'change_request', 'cr_1')).filter((r) => r.approverId === 'u2');
    const [a, b] = await Promise.all([
      decideApproval(db, { approvalId: other!.id, actor: 'u2', decision: 'approved' }),
      decideApproval(db, { approvalId: other!.id, actor: 'u2', decision: 'rejected', note: 'no' }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it('holds a later step until the earlier one is approved', async () => {
    const rows = await ask(
      'dl_1',
      [
        { approverId: 'sponsor', rule: { code: 'deliverable_sponsor' }, step: 1 },
        { approverId: 'client', approverKind: 'contact', rule: { code: 'deliverable_client' }, step: 2 },
      ],
      'deliverable',
    );
    const [sponsor, client] = rows;
    expect(await decideApproval(db, { approvalId: client!.id, actor: { kind: 'contact', id: 'client' }, decision: 'approved' })).toMatchObject({
      ok: false,
      code: 'step_not_active',
    });
    expect(await decideApproval(db, { approvalId: sponsor!.id, actor: 'sponsor', decision: 'approved' })).toMatchObject({
      ok: true,
      outcome: 'pending',
    });
    expect(
      await decideApproval(db, { approvalId: client!.id, actor: { kind: 'contact', id: 'client' }, decision: 'approved' }),
    ).toMatchObject({ ok: true, outcome: 'approved', resolved: true });
  });

  it('treats a request for information as an open answer that can be answered later', async () => {
    const [row] = await ask('cr_1', [{ approverId: 'u1', rule }]);
    const asked = await decideApproval(db, { approvalId: row!.id, actor: 'u1', decision: 'info_requested', note: 'What is the cost?' });
    expect(asked).toMatchObject({ ok: true, outcome: 'pending', resolved: false });
    const answered = await decideApproval(db, { approvalId: row!.id, actor: 'u1', decision: 'approved' });
    expect(answered).toMatchObject({ ok: true, outcome: 'approved', resolved: true });
  });
});

describe('subject handlers', () => {
  function track() {
    const calls: Array<{ subjectId: string; outcome: ResolvedApprovalOutcome; rows: number; actor: string | null }> = [];
    const handler: ApprovalSubjectHandler = {
      onResolved: (_db, subjectId, outcome, context) => {
        calls.push({ subjectId, outcome, rows: context.rows.length, actor: context.actor?.id ?? null });
      },
    };
    return { calls, handler };
  }

  it('runs onResolved once, when the last approver of a unanimous board approves', async () => {
    const { calls, handler } = track();
    registerApprovalSubject('change_request', handler);
    const rows = await ask('cr_1', [{ approverId: 'u1', rule }, { approverId: 'u2', rule }, { approverId: 'u3', rule }]);
    for (const [index, row] of rows.entries()) {
      await decideApproval(db, { approvalId: row.id, actor: row.approverId, decision: 'approved', now: NOW });
      expect(calls).toHaveLength(index === rows.length - 1 ? 1 : 0);
    }
    expect(calls).toEqual([{ subjectId: 'cr_1', outcome: 'approved', rows: 3, actor: 'u3' }]);
  });

  it('rejects on the first rejection, clears the other open rows and runs onResolved', async () => {
    const { calls, handler } = track();
    registerApprovalSubject('change_request', handler);
    const [first, second, third] = await ask('cr_1', [
      { approverId: 'u1', rule },
      { approverId: 'u2', rule },
      { approverId: 'u3', rule },
    ]);
    await decideApproval(db, { approvalId: first!.id, actor: 'u1', decision: 'approved' });
    const result = await decideApproval(db, { approvalId: second!.id, actor: 'u2', decision: 'rejected', note: 'Over budget' });
    expect(result).toMatchObject({ ok: true, outcome: 'rejected', resolved: true });
    expect(calls).toEqual([{ subjectId: 'cr_1', outcome: 'rejected', rows: 2, actor: 'u2' }]);

    const live = await listSubjectApprovals(db, 'change_request', 'cr_1');
    expect(live.map((r) => [r.approverId, r.decision]).sort()).toEqual([
      ['u1', 'approved'],
      ['u2', 'rejected'],
    ]);
    // The third approver is no longer asked.
    expect(await decideApproval(db, { approvalId: third!.id, actor: 'u3', decision: 'approved' })).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });

  it('uses a handler resolve over the default, and keeps the answer when onResolved fails', async () => {
    let attempts = 0;
    registerApprovalSubject('gate', {
      // Any one approval is enough for a gate in this test.
      resolve: (rows) => (rows.some((r) => r.decision === 'approved') ? 'approved' : 'pending'),
      onResolved: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('boom');
      },
    });
    const [a, b] = await ask('ph_1', [{ approverId: 'u1', rule: { code: 'gate' } }, { approverId: 'u2', rule: { code: 'gate' } }], 'gate');
    await expect(decideApproval(db, { approvalId: a!.id, actor: 'u1', decision: 'approved' })).rejects.toThrow('boom');
    // The answer is stored, the other approver is still open, and resolving again finishes the job.
    expect((await listSubjectApprovals(db, 'gate', 'ph_1')).map((r) => r.decision)).toEqual(['approved', 'pending']);
    const again = await resolveApprovalSubject(db, 'gate', 'ph_1', { now: NOW });
    expect(again).toMatchObject({ outcome: 'approved', resolved: true });
    expect(attempts).toBe(2);
    expect(b).toBeDefined();
  });

  it('settles a subject without a handler by the default rule and does nothing more', async () => {
    const [row] = await ask('cr_1', [{ approverId: 'u1', rule }]);
    expect(await decideApproval(db, { approvalId: row!.id, actor: 'u1', decision: 'approved' })).toMatchObject({
      ok: true,
      outcome: 'approved',
      resolved: true,
    });
  });

  it('refuses a second handler for a subject type', () => {
    const { handler } = track();
    registerApprovalSubject('change_request', handler);
    expect(() => registerApprovalSubject('change_request', handler)).toThrow(/already registered/);
  });
});

describe('listPendingForApprover', () => {
  it('lists the open reviews of one approver, earliest due date first, grouped in buckets', async () => {
    await ask('cr_late', [{ approverId: 'u1', rule, dueAt: new Date(NOW.getTime() + 10 * DAY) }]);
    await ask('cr_none', [{ approverId: 'u1', rule }]);
    await ask('cr_over', [{ approverId: 'u1', rule, dueAt: new Date(NOW.getTime() - DAY) }]);
    await ask('cr_week', [{ approverId: 'u1', rule, dueAt: new Date(NOW.getTime() + 2 * DAY) }]);
    await ask('cr_other', [{ approverId: 'u2', rule }]);

    const reviews = await listPendingForApprover(db, 'u1', { now: NOW });
    expect(reviews.map((r) => [r.approval.subjectId, r.bucket, r.viaDelegation, r.actionable])).toEqual([
      ['cr_over', 'overdue', false, true],
      ['cr_week', 'this_week', false, true],
      ['cr_late', 'later', false, true],
      ['cr_none', 'later', false, true],
    ]);
  });

  it('leaves out answered rows, rows waiting for information, and rows of another approver kind', async () => {
    const [a] = await ask('cr_done', [{ approverId: 'u1', rule }, { approverId: 'u2', rule }]);
    await decideApproval(db, { approvalId: a!.id, actor: 'u1', decision: 'approved' });
    const [b] = await ask('cr_info', [{ approverId: 'u1', rule }]);
    await decideApproval(db, { approvalId: b!.id, actor: 'u1', decision: 'info_requested' });
    await ask('cr_contact', [{ approverId: 'u1', approverKind: 'contact', rule }]);

    expect(await listPendingForApprover(db, 'u1', { now: NOW })).toEqual([]);
    const withInfo = await listPendingForApprover(db, 'u1', { now: NOW, decisions: ['pending', 'info_requested'] });
    expect(withInfo.map((r) => r.approval.subjectId)).toEqual(['cr_info']);
    const contact = await listPendingForApprover(db, 'u1', { now: NOW, approverKind: 'contact' });
    expect(contact.map((r) => r.approval.subjectId)).toEqual(['cr_contact']);
  });

  it('shows a later step only once the earlier one is approved, unless asked for', async () => {
    const [first] = await ask(
      'dl_1',
      [
        { approverId: 'sponsor', rule: { code: 'deliverable_sponsor' }, step: 1 },
        { approverId: 'u1', rule: { code: 'deliverable_client' }, step: 2 },
      ],
      'deliverable',
    );
    expect(await listPendingForApprover(db, 'u1', { now: NOW })).toEqual([]);
    const waiting = await listPendingForApprover(db, 'u1', { now: NOW, includeWaiting: true });
    expect(waiting.map((r) => [r.approval.subjectId, r.actionable])).toEqual([['dl_1', false]]);

    await decideApproval(db, { approvalId: first!.id, actor: 'sponsor', decision: 'approved' });
    const ready = await listPendingForApprover(db, 'u1', { now: NOW });
    expect(ready.map((r) => [r.approval.subjectId, r.actionable])).toEqual([['dl_1', true]]);
  });

  it('includes the reviews of members who delegated to this person while it lasts', async () => {
    await ask('cr_mine', [{ approverId: 'u9', rule }]);
    await ask('cr_theirs', [{ approverId: 'u1', rule }]);
    expect((await listPendingForApprover(db, 'u9', { now: NOW })).map((r) => r.approval.subjectId)).toEqual(['cr_mine']);

    await seedDelegation('u1', 'u9', new Date(NOW.getTime() - DAY), new Date(NOW.getTime() + DAY));
    const reviews = await listPendingForApprover(db, 'u9', { now: NOW });
    expect(reviews.map((r) => [r.approval.subjectId, r.viaDelegation]).sort()).toEqual([
      ['cr_mine', false],
      ['cr_theirs', true],
    ]);
    expect(await listPendingForApprover(db, 'u9', { now: NOW, includeDelegated: false })).toHaveLength(1);
    expect(await listPendingForApprover(db, 'u9', { now: new Date(NOW.getTime() + 2 * DAY) })).toHaveLength(1);
  });

  it('lists a row asked of a delegate for the member who delegated, as their own, after the delegation ended', async () => {
    await seedDelegation('u1', 'u9', new Date(NOW.getTime() - DAY), new Date(NOW.getTime() + DAY));
    await ask('cr_1', [{ approverId: 'u1', rule }]);
    const later = new Date(NOW.getTime() + 2 * DAY);
    expect((await listPendingForApprover(db, 'u1', { now: later })).map((r) => [r.approval.subjectId, r.viaDelegation])).toEqual([['cr_1', false]]);
    // The delegate keeps it as theirs.
    expect((await listPendingForApprover(db, 'u9', { now: later })).map((r) => [r.approval.subjectId, r.viaDelegation])).toEqual([['cr_1', false]]);
  });

  it('limits the reviews to the accessible projects and keeps the rows without a project', async () => {
    await db.insert(schema.projects).values([
      { id: 'prj_a', name: 'A', createdAt: NOW, updatedAt: NOW },
      { id: 'prj_b', name: 'B', createdAt: NOW, updatedAt: NOW },
    ]);
    for (const [subjectId, projectId] of [['cr_a', 'prj_a'], ['cr_b', 'prj_b'], ['cr_none', null]] as const) {
      const result = await requestApprovals(db, {
        projectId,
        subjectType: 'change_request',
        subjectId,
        requestedBy: 'requester',
        rows: [{ approverId: 'u1', rule }],
        now: NOW,
      });
      expect(result.ok).toBe(true);
    }
    const ids = async (accessibleProjectIds: string[] | null) =>
      (await listPendingForApprover(db, 'u1', { now: NOW, accessibleProjectIds })).map((r) => r.approval.subjectId).sort();
    expect(await ids(null)).toEqual(['cr_a', 'cr_b', 'cr_none']);
    expect(await ids(['prj_a'])).toEqual(['cr_a', 'cr_none']);
    expect(await ids([])).toEqual(['cr_none']);
  });

  it('filters by subject type and project, and respects the limit', async () => {
    const result = await requestApprovals(db, {
      projectId: null,
      subjectType: 'gate',
      subjectId: 'ph_1',
      requestedBy: 'requester',
      rows: [{ approverId: 'u1', rule: { code: 'gate' } }],
      now: NOW,
    });
    expect(result.ok).toBe(true);
    await ask('cr_1', [{ approverId: 'u1', rule }]);
    await ask('cr_2', [{ approverId: 'u1', rule }]);

    expect((await listPendingForApprover(db, 'u1', { now: NOW, subjectTypes: ['gate'] })).map((r) => r.approval.subjectId)).toEqual([
      'ph_1',
    ]);
    expect(await listPendingForApprover(db, 'u1', { now: NOW, limit: 2 })).toHaveLength(2);
  });
});

describe('cancelPendingApprovals', () => {
  it('clears the open rows and keeps the answered ones, unless told to clear everything', async () => {
    const [a] = await ask('cr_1', [{ approverId: 'u1', rule }, { approverId: 'u2', rule }]);
    await decideApproval(db, { approvalId: a!.id, actor: 'u1', decision: 'approved' });

    const cleared = await cancelPendingApprovals(db, { subjectType: 'change_request', subjectId: 'cr_1', now: NOW });
    expect(cleared.map((r) => r.approverId)).toEqual(['u2']);
    expect((await listSubjectApprovals(db, 'change_request', 'cr_1')).map((r) => r.approverId)).toEqual(['u1']);

    const all = await cancelPendingApprovals(db, { subjectType: 'change_request', subjectId: 'cr_1', includeDecided: true, now: NOW });
    expect(all.map((r) => r.approverId)).toEqual(['u1']);
    expect(await listSubjectApprovals(db, 'change_request', 'cr_1')).toEqual([]);
  });

  it('only touches its own subject', async () => {
    await ask('cr_1', [{ approverId: 'u1', rule }]);
    await ask('cr_2', [{ approverId: 'u1', rule }]);
    await cancelPendingApprovals(db, { subjectType: 'change_request', subjectId: 'cr_1' });
    expect(await listSubjectApprovals(db, 'change_request', 'cr_2')).toHaveLength(1);
  });
});

describe('findActiveDelegation', () => {
  it('finds the delegation in force for a member', async () => {
    await seedDelegation('u1', 'u9', new Date(NOW.getTime() - DAY), new Date(NOW.getTime() + DAY));
    expect(await findActiveDelegation(db, 'u1', NOW)).toMatchObject({ memberId: 'u1', delegateId: 'u9' });
    expect(await findActiveDelegation(db, 'u2', NOW)).toBeNull();
    expect(await findActiveDelegation(db, 'u1', new Date(NOW.getTime() + 2 * DAY))).toBeNull();
  });
});
