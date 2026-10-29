/**
 * Object-mode test for `SendScheduledEmailWorkflow`'s store wiring (design
 * task D1: "the Workflow reads and updates the message through the store; it
 * runs outside a request, so it resolves the store with `getWorkspaceMail`
 * from the Workflow env and the workspace id"). Runs the real Workflow class
 * with a fake `WorkflowStep` against a real `ObjectMailboxStore` (the C2
 * fakes, running the real `MailboxObject` class underneath) — only
 * `getTenantDbForWorkspace`/`getWorkspaceForOrg` are mocked (same "every
 * other export comes from the real module" approach `cron/snooze-sweep.test.ts`
 * uses for this exact pair of lookups), and the Cloudflare send transmit
 * itself, which this test is not about.
 */

vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(public readonly from: string, public readonly to: string, public readonly raw: string) {}
  },
}));

const sendEmail = vi.hoisted(() => vi.fn(async () => ({ messageId: '<ext-workflow-1@cf>', pendingVerification: false })));
vi.mock('@weldsuite/worker-email', () => ({ sendEmail }));

const tenantDbFor = vi.hoisted(() => vi.fn());
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getTenantDbForWorkspace: (env: unknown, orgId: string) => tenantDbFor(env, orgId),
    getWorkspaceForOrg: async (_env: unknown, orgId: string) => ({ id: `ws_${orgId}`, clerkOrgId: orgId }),
  };
});

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { WorkflowStep } from 'cloudflare:workers';
import { SendScheduledEmailWorkflow, type SendScheduledEmailEnv, type SendScheduledEmailParams } from './send-scheduled-email';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';
import { createFakeMailboxNamespace } from '../store/object/testing/fake-env';
import { ObjectMailboxStore } from '../store/object';
import type { IngestMessage, MailboxRef } from '../store/types';

const { mailAccounts } = schema;

const ORG_ID = 'org_wf_object';
const WORKSPACE_ID = `ws_${ORG_ID}`;
const USER = 'user_test';

/** Runs `.do` callbacks immediately (one attempt) and resolves `sleepUntil` right away. */
function createStep(): WorkflowStep {
  return {
    async do(_name: string, a: unknown, b?: unknown): Promise<unknown> {
      const fn = (typeof a === 'function' ? a : b) as () => Promise<unknown>;
      return fn();
    },
    async sleepUntil() {},
    async sleep() {},
  } as unknown as WorkflowStep;
}

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(() => {
  sendEmail.mockClear();
  tenantDbFor.mockReset().mockImplementation(async () => db);
});

describe('SendScheduledEmailWorkflow · object mode', () => {
  it('sends the scheduled message through the store and marks it sent, with no duplicate row left behind', async () => {
    const accountId = generateId('mail');
    await db.insert(mailAccounts).values({ id: accountId, name: 'Scheduled', email: `${accountId}@test.dev`, isShared: true, sentToday: 0 });

    const mailbox = createFakeMailboxNamespace();
    const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId, clerkOrgId: ORG_ID };
    const storeForAssertions = new ObjectMailboxStore({ MAILBOX_STORE: mailbox.namespace, MAIL_STORAGE: createMemoryR2() }, ref);

    const messageId = generateId('msg');
    const scheduledFor = new Date(Date.now() + 1000);
    const message: IngestMessage = {
      id: messageId,
      source: 'scheduled',
      rfcMessageId: `<${messageId}@scheduled.weldsuite.org>`,
      threadId: `<${messageId}@scheduled.weldsuite.org>`,
      from: { email: `${accountId}@test.dev` },
      to: [{ email: 'rcpt@example.com' }],
      subject: 'Scheduled hello',
      preview: 'Body text',
      sentAt: Date.now(),
      receivedAt: null,
      createdAt: Date.now(),
      isRead: true,
      labels: ['SENT', 'SCHEDULED'],
      isSpam: false,
      isReply: false,
      sendStatus: 'scheduled',
      scheduledFor: scheduledFor.getTime(),
      content: { html: null, text: 'Body text' },
      attachments: [],
    };
    await storeForAssertions.apply({ kind: 'ingest', message }, Date.now());
    await storeForAssertions.apply(
      { kind: 'scheduled', id: messageId, patch: { triggerRunId: messageId } },
      Date.now(),
    );

    const env = {
      FLAGSHIP: { getStringValue: async () => 'object' },
      WORKSPACE_CACHE: createMemoryKv(),
      MAILBOX_STORE: mailbox.namespace,
      MAIL_STORAGE: createMemoryR2(),
    } as unknown as SendScheduledEmailEnv;

    const event = {
      payload: { workspaceId: ORG_ID, userId: USER, messageId, accountId, scheduledFor: scheduledFor.toISOString() } satisfies SendScheduledEmailParams,
      timestamp: new Date(),
      instanceId: messageId,
    };

    await new SendScheduledEmailWorkflow({} as never, env).run(event as never, createStep());

    expect(sendEmail).toHaveBeenCalledTimes(1);

    const after = await storeForAssertions.getMessage(messageId);
    expect(after?.sendStatus).toBe('sent');
    expect(after?.externalMessageId).toBe('<ext-workflow-1@cf>');
    expect(after?.labels).not.toContain('SCHEDULED');

    // sendAndPersist's own ingest created a second SENT copy; the workflow
    // removes it, so the mailbox still holds exactly the one message.
    const page = await storeForAssertions.listMessages({ limit: 10 });
    expect(page.data).toHaveLength(1);
    expect(page.data[0]!.id).toBe(messageId);

    // `sentToday` stays a direct-Postgres bump in every mode (design §1).
    const [account] = await db.select({ sentToday: mailAccounts.sentToday }).from(mailAccounts);
    expect(account?.sentToday).toBe(1);
  }, 30_000);
});
