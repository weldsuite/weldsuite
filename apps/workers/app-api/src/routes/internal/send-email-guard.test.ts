/**
 * POST /api/internal/send-email (workflow-worker's WeldConnect send_email
 * action) behind the outbound mail guard: the email is sent as a `workflow`
 * new thread for the workspace in the body, and a refusal answers with the
 * guard's status and the app-api error envelope so the caller can stop its loop.
 *
 * The guard's own checks are covered in @weldsuite/mail-domain; here it is
 * stubbed at the module boundary. /send-transactional-email (WeldSuite's own
 * mail) must stay outside it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { OutboundDeniedError, guardedSend } from '@weldsuite/mail-domain/outbound';
import { sendEmail } from '@weldsuite/worker-email';
import { getTenantDbForWorkspace } from '@weldsuite/worker-kit/db';
import { internalRoutes } from './index';
import type { Env, Variables } from '../../types';

vi.mock('@weldsuite/worker-email', () => ({ sendEmail: vi.fn() }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getTenantDbForWorkspace: vi.fn(),
}));
// Keep the real `OutboundDeniedError` (the route tests for it), stub the guard.
vi.mock('@weldsuite/mail-domain/outbound', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/mail-domain/outbound')>()),
  guardedSend: vi.fn(),
}));

const guard = vi.mocked(guardedSend);
const send = vi.mocked(sendEmail);
const tenantDb = vi.mocked(getTenantDbForWorkspace);

const env = { ENVIRONMENT: 'test' } as unknown as Env;
const executionCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
const db = { tenant: true } as never;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', async (c, next) => {
  c.set('internalTrusted', true);
  await next();
});
app.route('/api/internal', internalRoutes);

const post = (path: string, body: unknown) =>
  app.request(
    `/api/internal${path}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    env,
    executionCtx,
  );

const email = {
  workspaceId: 'org_flow',
  from: 'Sales <sales@acme.test>',
  to: ['prospect@example.org'],
  cc: ['boss@example.org'],
  subject: 'Hello',
  html: '<p>Hi</p>',
  text: 'Hi',
};

beforeEach(() => {
  vi.resetAllMocks();
  tenantDb.mockResolvedValue(db);
  send.mockResolvedValue({ messageId: 'msg_1' });
  // Allowed by default: run the send, like the real guard does.
  guard.mockImplementation(async (_env, _db, _input, run) => run());
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/internal/send-email', () => {
  it('sends through the guard as a workflow new thread for the workspace in the body', async () => {
    const res = await post('/send-email', email);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, messageId: 'msg_1' });

    expect(tenantDb).toHaveBeenCalledWith(env, 'org_flow');
    expect(guard).toHaveBeenCalledTimes(1);
    const [guardEnv, guardDb, input, , opts] = guard.mock.calls[0]!;
    expect(guardEnv).toBe(env);
    expect(guardDb).toBe(db);
    expect(input).toMatchObject({
      subject: { kind: 'workspace', clerkOrgId: 'org_flow' },
      source: 'workflow',
      kind: 'new_thread',
      from: 'Sales <sales@acme.test>',
      to: ['prospect@example.org'],
      cc: ['boss@example.org'],
      subjectLine: 'Hello',
      text: 'Hi',
      html: '<p>Hi</p>',
    });
    expect(opts).toEqual({ waitUntil: expect.any(Function) });
    expect(send).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ from: 'Sales <sales@acme.test>', to: ['prospect@example.org'], subject: 'Hello' }),
    );
  });

  it('counts the send after the response through the execution context', async () => {
    await post('/send-email', email);
    const opts = guard.mock.calls[0]![4]!;
    const work = Promise.resolve();
    opts.waitUntil!(work);
    expect(executionCtx.waitUntil).toHaveBeenCalledWith(work);
  });

  it.each([
    ['SENDING_LIMITED', 429, { code: 'SENDING_LIMITED' as const, window: 'day' as const, limit: 150, used: 150, retryAfter: '2026-10-14T00:00:00.000Z' }],
    ['FIRST_CONTACT_LIMITED', 429, { code: 'FIRST_CONTACT_LIMITED' as const, window: 'day' as const, limit: 50, reason: 'cold_outreach_template', suggestWeldReach: true }],
    ['SENDING_ON_HOLD', 403, { code: 'SENDING_ON_HOLD' as const }],
    ['SENDING_SUSPENDED', 403, { code: 'SENDING_SUSPENDED' as const }],
    ['SENDER_NOT_OWNED', 403, { code: 'SENDER_NOT_OWNED' as const, reason: 'address_registered_elsewhere' }],
    ['RECIPIENT_SUPPRESSED', 422, { code: 'RECIPIENT_SUPPRESSED' as const, recipients: ['prospect@example.org'] }],
  ])('answers a %s denial with status %i and the error envelope, without sending', async (code, status, details) => {
    guard.mockRejectedValueOnce(new OutboundDeniedError(details));

    const res = await post('/send-email', email);

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({
      error: { code, message: expect.any(String), details },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('still answers 500 with the legacy shape for any other send failure', async () => {
    guard.mockImplementationOnce(async () => {
      throw new Error('send_email failed');
    });
    const res = await post('/send-email', email);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: 'send_email failed' });
  });

  it('runs the guard without the tenant DB when it cannot be resolved (the guard degrades, the send is not blocked)', async () => {
    tenantDb.mockRejectedValueOnce(new Error('workspace not found'));
    const res = await post('/send-email', email);
    expect(res.status).toBe(200);
    expect(guard.mock.calls[0]![1]).toBeNull();
  });

  it('sends without the guard, and says so, while an older workflow-worker omits the workspace', async () => {
    const { workspaceId: _omitted, ...legacy } = email;

    const res = await post('/send-email', legacy);

    expect(res.status).toBe(200);
    expect(guard).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('outbound guard skipped'));
  });
});

describe('POST /api/internal/send-transactional-email', () => {
  it("is WeldSuite's own mail: it never goes through the guard", async () => {
    const { workspaceId: _ws, ...params } = email;
    const res = await post('/send-transactional-email', params);

    expect(res.status).toBe(200);
    expect(guard).not.toHaveBeenCalled();
    expect(tenantDb).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
