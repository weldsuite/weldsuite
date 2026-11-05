/**
 * DB-backed integration tests for the client portal: /public/project-portal.
 * Runs against the TypeScript worker and, in conformance mode, the Rust
 * backend (rust/conformance/suites.json, suite "flow: client portal").
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createSendEmailStub } from '@weldsuite/worker-kit/testing/send-email';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { requestApprovals } from '@weldsuite/flow-domain/approvals';
import {
  PORTAL_REQUEST_LIMIT_WORKSPACE,
  PORTAL_VERIFY_LIMIT_WORKSPACE,
  portalCodeHash,
  portalCodeKey,
  sha256Hex,
} from '@weldsuite/flow-domain/project-portal';
import { createMemoryRateLimitNamespace, createUnreachableRateLimitNamespace } from '../../testing/memory-rate-limiter';
import type { Env } from '../../types';
import { publicProjectPortalRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const WORKSPACE_ID = 'ws_portal_test';
const SLUG = 'acme';
let db: Database;

class MemoryKV {
  private store = new Map<string, string>();
  async get(key: string, type?: string): Promise<unknown> {
    const raw = this.store.get(key);
    if (raw == null) return null;
    return type === 'json' ? JSON.parse(raw) : raw;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  keys(): string[] {
    return [...this.store.keys()];
  }
}

const published = vi.mocked(publishEntityEvent);
const actions = () => published.mock.calls.map(([e]) => `${e.entityType}.${e.action}`);
beforeEach(() => {
  published.mockClear();
});

function portal(kv = new MemoryKV(), limiter: Env['PORTAL_RATE_LIMITER'] | null = createMemoryRateLimitNamespace() as never) {
  const mail = createSendEmailStub();
  const { request } = createTestApp('/public/project-portal', publicProjectPortalRoutes, {
    context: { tenantDb: db, workspaceId: WORKSPACE_ID },
    env: {
      WORKSPACE_CACHE: kv as unknown as KVNamespace,
      SEND_EMAIL: mail as unknown as SendEmail,
      ...(limiter ? { PORTAL_RATE_LIMITER: limiter } : {}),
    },
  });
  const send = (method: string, path: string, body?: unknown, token?: string) =>
    request(`/public/project-portal${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { kv, mail, send };
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const now = new Date('2026-11-01T08:00:00.000Z');

async function seedContact(id: string, email: string, name: string) {
  await db.insert(schema.people).values({ id, displayName: name, email });
}

async function seedProject(id: string, name: string, extra: Record<string, unknown> = {}) {
  await db.insert(schema.projects).values({ id, name, createdAt: now, updatedAt: now, progress: '58.00', ...extra } as never);
}

async function stakeholder(projectId: string, contactId: string, portalAccess = true) {
  await db.insert(schema.projectStakeholders).values({
    id: `stk_${projectId}_${contactId}`,
    projectId,
    crmContactId: contactId,
    portalAccess,
    createdBy: 'user_pm',
  });
}

/** Signs in with a challenge stored by the test (the code itself is only ever mailed). */
async function signIn(p: ReturnType<typeof portal>, email: string): Promise<string> {
  const code = '123456';
  const ids = (await db.select({ id: schema.people.id }).from(schema.people).where(eq(schema.people.email, email))).map((r) => r.id);
  await p.kv.put(
    portalCodeKey(WORKSPACE_ID, email),
    JSON.stringify({
      codeHash: await portalCodeHash(WORKSPACE_ID, email, code),
      email,
      workspaceId: WORKSPACE_ID,
      contactIds: ids,
      attempts: 0,
    }),
  );
  const res = await p.send('POST', '/auth/verify', { workspace: SLUG, email, code });
  expect(res.status).toBe(200);
  return (await json<{ data: { token: string } }>(res)).data.token;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await seedContact('pe_femke', 'femke@client.test', 'Femke de Graaf');
  await seedContact('pe_other', 'other@client.test', 'Other Person');
  await db.insert(schema.workspaceMembers).values({
    id: 'wm_sanne',
    userId: 'user_sanne',
    email: 'sanne@internal.test',
    name: 'Sanne Jansen',
    role: 'MEMBER',
  } as never);
  await seedProject('prj_p1', 'Customer Portal Relaunch', {
    projectManagerId: 'user_sanne',
    endDate: new Date('2027-01-15T00:00:00Z'),
    budgetedAmount: '99999.00',
    budgetCurrency: 'EUR',
  });
  await seedProject('prj_p2', 'Other client project');
  await seedProject('prj_p3', 'No access project');
  await stakeholder('prj_p1', 'pe_femke');
  await stakeholder('prj_p2', 'pe_other');
  await stakeholder('prj_p3', 'pe_femke', false);
  await db.insert(schema.milestones).values([
    { id: 'ms_done', projectId: 'prj_p1', name: 'Alpha', dueDate: new Date('2026-10-01T00:00:00Z'), status: 'completed' },
    { id: 'ms_beta', projectId: 'prj_p1', name: 'Beta', dueDate: new Date('2026-12-01T00:00:00Z'), status: 'pending' },
  ] as never);
  await db.insert(schema.projectDeliverables).values([
    {
      id: 'del_1', projectId: 'prj_p1', number: 1, title: 'Account and login', description: 'Ready', clientVisible: true, createdBy: 'user_pm',
      acceptanceCriteria: [{ text: 'Sign in works', met: true, metAt: null }, { text: 'Dutch texts', met: false, metAt: null }],
    },
    { id: 'del_2', projectId: 'prj_p1', number: 2, title: 'Internal only', clientVisible: false, createdBy: 'user_pm' },
  ] as never);
  await db.insert(schema.projectChangeRequests).values({
    id: 'cr_8', projectId: 'prj_p1', number: 8, title: 'Pay in 3', description: 'Split payments', status: 'awaiting_approval',
    costDelta: '7500.00', scheduleDeltaDays: 6, planChanges: { goLive: '2027-01-25' }, clientVisible: true, createdBy: 'user_pm',
  } as never);
  await db.insert(schema.projectStatusReports).values([
    {
      id: 'rpt_pub', projectId: 'prj_p1', period: '2026-W45', status: 'published', overall: 'amber',
      areas: [{ key: 'schedule', colour: 'amber', reason: 'INTERNAL reason', auto: false }],
      summary: 'Going well', done: [{ text: 'Login' }], next: [{ text: 'Ordering' }], snapshot: { version: 1, cost: 12345 },
      clientVisible: true, publishedBy: 'user_sanne', publishedAt: new Date('2026-11-02T08:00:00Z'), createdBy: 'user_sanne',
    },
    { id: 'rpt_hidden', projectId: 'prj_p1', period: '2026-W44', status: 'published', clientVisible: false, publishedAt: new Date('2026-10-26T08:00:00Z'), createdBy: 'user_sanne' },
    { id: 'rpt_draft', projectId: 'prj_p1', period: '2026-W46', status: 'draft', clientVisible: true, createdBy: 'user_sanne' },
  ] as never);
  await db.insert(schema.projectFiles).values([
    { id: 'pf_shared', projectId: 'prj_p1', fileName: 'plan.pdf', mimeType: 'application/pdf', fileSize: 10, storagePath: 'k', clientVisible: true },
    { id: 'pf_private', projectId: 'prj_p1', fileName: 'secret.pdf', mimeType: 'application/pdf', fileSize: 10, storagePath: 'k', clientVisible: false },
  ] as never);
  await db.insert(schema.files).values([
    { id: 'f_doc', fileName: 'Beta plan.docx', mimeType: 'x', fileSize: 1, fileType: 'document', storagePath: 'k', entityType: 'project', entityId: 'prj_p1', clientVisible: true },
    { id: 'f_doc2', fileName: 'Internal.docx', mimeType: 'x', fileSize: 1, fileType: 'document', storagePath: 'k', entityType: 'project', entityId: 'prj_p1' },
  ] as never);
  await db.insert(schema.projectMessages).values([
    { id: 'pm_team', projectId: 'prj_p1', conversationId: 'prj_p1', senderId: 'user_sanne', message: 'D1 is ready', clientVisible: true },
    { id: 'pm_internal', projectId: 'prj_p1', conversationId: 'prj_p1', senderId: 'user_sanne', message: 'internal chatter', clientVisible: false },
  ] as never);
  await requestApprovals(db, {
    projectId: 'prj_p1', subjectType: 'deliverable', subjectId: 'del_1', requestedBy: 'user_sanne',
    rows: [{ approverKind: 'contact', approverId: 'pe_femke', rule: { code: 'deliverable_client' } }],
  });
  await requestApprovals(db, {
    projectId: 'prj_p1', subjectType: 'change_request', subjectId: 'cr_8', requestedBy: 'user_sanne',
    rows: [{ approverKind: 'contact', approverId: 'pe_femke', rule: { code: 'change_board_over_limit' } }],
  });
}, 60_000);

describe('sign-in', () => {
  it('answers 204 for any address and mails a code only to one with access', async () => {
    const p = portal();
    expect((await p.send('POST', '/auth/request-code', { workspace: SLUG, email: 'femke@client.test' })).status).toBe(204);
    expect((await p.send('POST', '/auth/request-code', { workspace: SLUG, email: 'nobody@client.test' })).status).toBe(204);
    expect((await p.send('POST', '/auth/request-code', { workspace: SLUG, email: 'other@client.test' })).status).toBe(204);
    expect(p.mail.sent.map((m) => m.to).sort()).toEqual(['femke@client.test', 'other@client.test']);
    expect(p.kv.keys()).toHaveLength(2);
  });

  it('does not send for a contact whose portal access is off', async () => {
    await seedContact('pe_off', 'off@client.test', 'Off');
    await stakeholder('prj_p2', 'pe_off', false);
    const p = portal();
    expect((await p.send('POST', '/auth/request-code', { workspace: SLUG, email: 'off@client.test' })).status).toBe(204);
    expect(p.mail.sent).toHaveLength(0);
  });

  it('rejects a malformed body and refuses when the limiter is unreachable', async () => {
    const p = portal();
    const bad = await p.send('POST', '/auth/request-code', { workspace: SLUG, email: 'not-an-email' });
    expect(bad.status).toBe(400);
    expect((await json<{ error: { message: string } }>(bad)).error.message).toBe('Invalid request body');
    const down = portal(new MemoryKV(), createUnreachableRateLimitNamespace() as never);
    expect((await down.send('POST', '/auth/request-code', { workspace: SLUG, email: 'femke@client.test' })).status).toBe(503);
    const none = portal(new MemoryKV(), null);
    expect((await none.send('POST', '/auth/request-code', { workspace: SLUG, email: 'femke@client.test' })).status).toBe(503);
  });

  it('limits code requests per address, answering 204 and sending no more mail', async () => {
    const p = portal();
    for (let i = 0; i < 7; i++) {
      expect((await p.send('POST', '/auth/request-code', { workspace: SLUG, email: 'femke@client.test' })).status).toBe(204);
    }
    expect(p.mail.sent).toHaveLength(5);
  });

  it('verifies a code once and stores no plain token', async () => {
    const p = portal();
    await p.send('POST', '/auth/request-code', { workspace: SLUG, email: 'femke@client.test' });
    const wrong = await p.send('POST', '/auth/verify', { workspace: SLUG, email: 'femke@client.test', code: '000000' });
    expect(wrong.status).toBe(401);
    expect((await json<{ error: { message: string } }>(wrong)).error.message).toBe('Invalid or expired code');
    const token = await signIn(p, 'femke@client.test');
    expect(p.kv.keys().some((k) => k.includes(token))).toBe(false);
    expect(p.kv.keys()).toContain(`pportal:sess:${await sha256Hex(token)}`);
    expect((await p.send('POST', '/auth/verify', { workspace: SLUG, email: 'femke@client.test', code: '123456' })).status).toBe(401);
  });

  it('throws a code away after too many wrong guesses', async () => {
    const p = portal();
    await p.send('POST', '/auth/request-code', { workspace: SLUG, email: 'femke@client.test' });
    for (let i = 0; i < 8; i++) {
      expect((await p.send('POST', '/auth/verify', { workspace: SLUG, email: 'femke@client.test', code: '000001' })).status).toBe(401);
    }
    expect(p.kv.keys().find((k) => k.startsWith('pportal:code:'))).toBeUndefined();
  });

  it('does not charge the workspace budget for verify calls with no pending code', async () => {
    const p = portal();
    for (let i = 0; i <= PORTAL_VERIFY_LIMIT_WORKSPACE; i++) {
      const res = await p.send('POST', '/auth/verify', { workspace: SLUG, email: `junk${i}@nowhere.test`, code: '000000' });
      expect(res.status).toBe(401);
      expect((await json<{ error: { message: string } }>(res)).error.message).toBe('Invalid or expired code');
    }
    // A real client of the workspace still signs in.
    await signIn(p, 'femke@client.test');
  }, 60_000);

  it('does not charge the workspace budget for code requests to addresses without access', async () => {
    const p = portal();
    for (let i = 0; i <= PORTAL_REQUEST_LIMIT_WORKSPACE; i++) {
      expect((await p.send('POST', '/auth/request-code', { workspace: SLUG, email: `junk${i}@nowhere.test` })).status).toBe(204);
    }
    expect(p.mail.sent).toHaveLength(0);
    // A real client of the workspace still gets a mail.
    expect((await p.send('POST', '/auth/request-code', { workspace: SLUG, email: 'femke@client.test' })).status).toBe(204);
    expect(p.mail.sent.map((m) => m.to)).toEqual(['femke@client.test']);
  }, 60_000);

  it('signs out', async () => {
    const p = portal();
    const token = await signIn(p, 'femke@client.test');
    expect((await p.send('POST', '/auth/sign-out', undefined, token)).status).toBe(204);
    expect((await p.send('GET', '/me', undefined, token)).status).toBe(401);
  });
});

describe('session', () => {
  it('needs a token and a live session', async () => {
    const p = portal();
    expect((await p.send('GET', '/projects')).status).toBe(401);
    expect((await p.send('GET', '/projects', undefined, 'nope')).status).toBe(401);
  });

  it('is revoked at once when portal access is switched off', async () => {
    await seedContact('pe_rev', 'rev@client.test', 'Rev');
    await seedProject('prj_rev', 'Rev project');
    await stakeholder('prj_rev', 'pe_rev');
    const p = portal();
    const token = await signIn(p, 'rev@client.test');
    expect((await p.send('GET', '/projects', undefined, token)).status).toBe(200);
    await db.update(schema.projectStakeholders).set({ portalAccess: false }).where(eq(schema.projectStakeholders.projectId, 'prj_rev'));
    const res = await p.send('GET', '/projects', undefined, token);
    expect(res.status).toBe(401);
    expect((await json<{ error: { message: string } }>(res)).error.message).toBe('Access revoked');
  });

  it('is revoked when the contact email changes after sign-in', async () => {
    await seedContact('pe_moved', 'moved@client.test', 'Moved');
    await seedProject('prj_moved', 'Moved project');
    await stakeholder('prj_moved', 'pe_moved');
    const p = portal();
    const token = await signIn(p, 'moved@client.test');
    expect((await p.send('GET', '/projects', undefined, token)).status).toBe(200);
    await db.update(schema.people).set({ email: 'someone-else@client.test' }).where(eq(schema.people.id, 'pe_moved'));
    const res = await p.send('GET', '/projects', undefined, token);
    expect(res.status).toBe(401);
    expect((await json<{ error: { message: string } }>(res)).error.message).toBe('Access revoked');
  });
});

describe('projects', () => {
  it("lists only the contact's projects and never a cost", async () => {
    const p = portal();
    const token = await signIn(p, 'femke@client.test');
    const body = await json<{ data: Array<Record<string, unknown>> }>(await p.send('GET', '/projects', undefined, token));
    expect(body.data.map((r) => r.id)).toEqual(['prj_p1']);
    expect(body.data[0]).toMatchObject({ name: 'Customer Portal Relaunch', progress: 58, projectManagerName: 'Sanne Jansen', waitingForYou: 2, nextMilestone: { name: 'Beta' } });
    expect(JSON.stringify(body)).not.toMatch(/99999|budget|sanne@internal/i);
  });

  it('shows a project with its shared items only', async () => {
    const p = portal();
    const token = await signIn(p, 'femke@client.test');
    const { data } = await json<{ data: Record<string, any> }>(await p.send('GET', '/projects/prj_p1', undefined, token));
    expect(data.deliverables.map((d: { code: string }) => d.code)).toEqual(['D1']);
    expect(data.changeRequests[0]).toMatchObject({ code: 'CR-8', costDelta: '7500.00', currency: 'EUR' });
    expect(data.milestones).toHaveLength(2);
    expect(data.latestReport).toMatchObject({ id: 'rpt_pub', areas: [{ key: 'schedule', colour: 'amber' }], done: ['Login'] });
    expect(JSON.stringify(data)).not.toMatch(/INTERNAL reason|12345|snapshot|99999/);
  });

  it('answers 404 for a project of another contact or without access', async () => {
    const p = portal();
    const token = await signIn(p, 'femke@client.test');
    expect((await p.send('GET', '/projects/prj_p2', undefined, token)).status).toBe(404);
    expect((await p.send('GET', '/projects/prj_p3', undefined, token)).status).toBe(404);
    expect((await p.send('GET', '/projects/prj_p2/messages', undefined, token)).status).toBe(404);
  });

  it('lists client visible reports, files, documents and messages only', async () => {
    const p = portal();
    const token = await signIn(p, 'femke@client.test');
    const ids = async (path: string) =>
      (await json<{ data: Array<{ id: string }> }>(await p.send('GET', path, undefined, token))).data.map((r) => r.id);
    expect(await ids('/projects/prj_p1/reports')).toEqual(['rpt_pub']);
    expect(await ids('/projects/prj_p1/files')).toEqual(['pf_shared']);
    expect(await ids('/projects/prj_p1/documents')).toEqual(['f_doc']);
    expect(await ids('/projects/prj_p1/messages')).toEqual(['pm_team']);
  });

  it('refuses the download of a file that is not shared', async () => {
    const p = portal();
    const token = await signIn(p, 'femke@client.test');
    expect((await p.send('GET', '/projects/prj_p1/files/pf_private/download', undefined, token)).status).toBe(404);
    expect((await p.send('GET', '/projects/prj_p1/documents/f_doc2/download', undefined, token)).status).toBe(404);
  });
});

describe('messages', () => {
  it('posts to the thread as the contact and publishes the event', async () => {
    const p = portal();
    const token = await signIn(p, 'femke@client.test');
    expect((await p.send('POST', '/projects/prj_p1/messages', { message: '  ' }, token)).status).toBe(400);
    published.mockClear();
    const res = await p.send('POST', '/projects/prj_p1/messages', { message: 'Thanks!' }, token);
    expect(res.status).toBe(201);
    const { data } = await json<{ data: Record<string, unknown> }>(res);
    expect(data).toMatchObject({ senderName: 'Femke de Graaf', fromClient: true, mine: true, message: 'Thanks!' });
    expect(actions()).toEqual(['project_message.created']);
    expect(published.mock.calls[0]![0].data).toMatchObject({ projectId: 'prj_p1', senderId: 'pe_femke' });
    const thread = await json<{ data: Array<{ message: string; mine: boolean }> }>(await p.send('GET', '/projects/prj_p1/messages', undefined, token));
    expect(thread.data.find((m) => m.message === 'Thanks!')).toMatchObject({ mine: true });
  });
});

describe('approvals', () => {
  it('lists the reviews addressed to the contact with their context', async () => {
    const p = portal();
    const token = await signIn(p, 'femke@client.test');
    const { data } = await json<{ data: Array<Record<string, any>> }>(await p.send('GET', '/approvals', undefined, token));
    expect(data.map((a) => a.code).sort()).toEqual(['CR-8', 'D1']);
    const d1 = data.find((a) => a.code === 'D1')!;
    expect(d1.acceptanceCriteria).toEqual([{ text: 'Sign in works', met: true }, { text: 'Dutch texts', met: false }]);
    expect(d1.requestedByName).toBe('Sanne Jansen');
    expect(data.find((a) => a.code === 'CR-8')!.impact).toEqual({ costDelta: '7500.00', currency: 'EUR', scheduleDeltaDays: 6, newGoLive: '2027-01-25' });
  });

  it('answers a review as the contact, with events, and refuses a second answer', async () => {
    const p = portal();
    const token = await signIn(p, 'femke@client.test');
    const { data } = await json<{ data: Array<{ id: string; code: string }> }>(await p.send('GET', '/approvals', undefined, token));
    const cr = data.find((a) => a.code === 'CR-8')!;
    const noNote = await p.send('POST', `/approvals/${cr.id}/decide`, { decision: 'rejected' }, token);
    expect(noNote.status).toBe(400);
    expect((await json<{ error: { message: string } }>(noNote)).error.message).toBe('A note is required to decline or to set conditions');
    published.mockClear();
    const ok = await p.send('POST', `/approvals/${cr.id}/decide`, { decision: 'approved' }, token);
    expect(ok.status).toBe(200);
    expect((await json<{ data: Record<string, unknown> }>(ok)).data).toMatchObject({ decision: 'approved', outcome: 'approved', resolved: true });
    // The same aftermath as a member's answer: the change, the project it moved and the decision log entry.
    expect(actions()).toEqual([
      'flow_approval.decided',
      'project_change_request.approved',
      'project.updated',
      'project_decision.created',
      'project_decision.decided',
    ]);
    const [row] = await db.select().from(schema.flowApprovals).where(eq(schema.flowApprovals.id, cr.id));
    expect(row!.decidedBy).toBe('pe_femke');
    expect((await p.send('POST', `/approvals/${cr.id}/decide`, { decision: 'approved' }, token)).status).toBe(409);
  });

  it('answers 404 for a review of someone else', async () => {
    await requestApprovals(db, {
      projectId: 'prj_p2', subjectType: 'deliverable', subjectId: 'del_x', requestedBy: 'user_sanne',
      rows: [{ approverKind: 'contact', approverId: 'pe_other', rule: { code: 'deliverable_client' } }],
    });
    const [other] = await db.select().from(schema.flowApprovals).where(eq(schema.flowApprovals.subjectId, 'del_x'));
    const p = portal();
    const token = await signIn(p, 'femke@client.test');
    expect((await p.send('POST', `/approvals/${other!.id}/decide`, { decision: 'approved' }, token)).status).toBe(404);
  });
});
