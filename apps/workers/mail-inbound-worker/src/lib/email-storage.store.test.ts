/**
 * `storeEmail` through the mailbox store (docs/plans/weldmail-mailbox-store-design.md
 * task D4): object-mode ingest via the C2 fakes (threading, idempotent
 * redelivery, bodies in R2 exactly once), the pure mail-rule/AI-label fold
 * into `inbound.finalize`, and the entity-event publish gating by
 * `mailbox.backend`. `storeEmail`'s postgres-mode row shape and the personal
 * path are unit-tested elsewhere (`email-storage.test.ts` covers
 * `storeRawMimeToR2`; the rest of postgres-mode parity is the existing
 * pglite/contract suites in `@weldsuite/mail-domain`, untouched by this file).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `./email-storage` transitively imports `@weldsuite/notifications`, which
// imports the Workers-only `cloudflare:email` module (send bindings) — stub
// it so the module graph resolves under vitest's node environment, the same
// way `email-storage.test.ts` and `packages/domains/mail/src/forward.test.ts` do.
vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(
      public readonly from: string,
      public readonly to: string,
      public readonly raw: string,
    ) {}
  },
}));

// `finishWorkspaceDelivery`'s non-ingest steps (contacts, the hub publish) are
// not under test here — isolated the same way `contact-upsert.test.ts` and
// `realtime-inbound-publish.test.ts` isolate their own callers.
const upsertContactsFromMailMessage = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./contact-upsert', () => ({ upsertContactsFromMailMessage }));

const publishInboundEmailCreated = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./realtime', () => ({
  publishNewEmailToUser: vi.fn(async () => {}),
  publishNewPersonalEmail: vi.fn(async () => {}),
  publishInboundEmailCreated,
  publishDeskInbound: vi.fn(async () => {}),
}));

// `classifyAndRunRules` (inside `finishWorkspaceDelivery`) reads AI-label and
// mail-rule *definitions* straight off the tenant DB (design: these stay on
// Postgres in every store mode) — a thenable, chainable fake that always
// answers "no labels, no rules" keeps the entity-event gating test isolated
// from real Jev/Postgres calls; `tenantSchema` itself stays real (its own
// `importOriginal`) so `eq(mailLabels.accountId, …)` still has real columns.
const getTenantDbForWorkspaceById = vi.hoisted(() =>
  vi.fn(async () => ({
    select: () => ({
      from: () => ({
        where: () => Object.assign(Promise.resolve([]), { orderBy: () => Promise.resolve([]) }),
      }),
    }),
  })),
);
vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return { ...actual, getTenantDbForWorkspaceById };
});

import { ObjectMailboxStore } from '@weldsuite/mail-domain/store/object';
import { createFakeMailboxNamespace } from '@weldsuite/mail-domain/store/object/testing/fake-env';
import { MemoryR2Bucket } from '@weldsuite/mail-domain/store/testing/memory-r2';
import { bodyHtmlKey, bodyTextKey, messageObjectPrefix } from '@weldsuite/mail-domain/store/bodies';
import type { RuleMessageState } from '@weldsuite/mail-domain/store/model';
import type { MailboxStore } from '@weldsuite/mail-domain/store';

import { applyMailRules, finishWorkspaceDelivery, storeEmail } from './email-storage';
import type { Env } from '../index';
import type { ParsedEmail, RecipientAccount, StoreEmailResult } from './email-storage';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENV = { STORAGE: {} as R2Bucket, R2_PUBLIC_URL: '' } as unknown as Env;

function makeAccount(overrides: Partial<RecipientAccount> = {}): RecipientAccount {
  return {
    accountId: 'acct_1',
    accountEmail: 'inbox@weldmail.com',
    isShared: false,
    tenantKind: 'workspace',
    workspaceId: 'ws_1',
    clerkOrgId: 'org_1',
    personalAccountId: null,
    clerkUserId: null,
    members: [],
    ...overrides,
  };
}

function makeEmail(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    emailId: 'raw_1',
    messageId: '<default@example.com>',
    from: { email: 'alice@example.com', name: 'Alice' },
    to: [{ email: 'inbox@weldmail.com' }],
    cc: [],
    subject: 'Hello',
    textBody: 'Hi there',
    htmlBody: '<p>Hi there</p>',
    headers: {},
    receivedAt: new Date('2026-01-01T00:00:00.000Z'),
    hasAttachments: false,
    attachmentCount: 0,
    ...overrides,
  };
}

function makeMailbox(ref = { workspaceId: 'ws_1', accountId: 'acct_1' }) {
  const { namespace } = createFakeMailboxNamespace();
  const bucket = new MemoryR2Bucket();
  const mailbox = new ObjectMailboxStore({ MAILBOX_STORE: namespace, MAIL_STORAGE: bucket.asBucket() }, ref);
  return { mailbox, bucket, ref };
}

beforeEach(() => {
  upsertContactsFromMailMessage.mockClear();
  publishInboundEmailCreated.mockClear();
  getTenantDbForWorkspaceById.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// storeEmail — object-mode ingest (design task D4)
// ---------------------------------------------------------------------------

describe('storeEmail: object-mode ingest through the mailbox store', () => {
  it('ingests a fresh inbound email and writes its body to MAIL_STORAGE exactly once', async () => {
    const { mailbox, bucket, ref } = makeMailbox();
    const email = makeEmail({ messageId: '<fresh@example.com>' });

    const result = await storeEmail(ENV, makeAccount(), email, [], undefined, mailbox);

    expect(result).not.toBeNull();
    expect(result?.isSpam).toBe(false);

    const stored = await mailbox.getMessage(result!.messageId, { bodies: true });
    expect(stored?.htmlBody).toBe(email.htmlBody);
    expect(stored?.textBody).toBe(email.textBody);
    expect(stored?.labels).toEqual(['INBOX']);

    // Exactly one html + one text object under this message's prefix — the
    // object store's own `ingest` R2 put, not a second write from this file.
    const bodyRef = { workspaceId: ref.workspaceId, accountId: ref.accountId, messageId: result!.messageId };
    const prefix = messageObjectPrefix(bodyRef);
    const keysUnderPrefix = [...bucket.objects.keys()].filter((k) => k.startsWith(prefix));
    expect(keysUnderPrefix.sort()).toEqual([bodyHtmlKey(bodyRef), bodyTextKey(bodyRef)].sort());
  });

  it('threads a reply to the original message via resolveInbound', async () => {
    const { mailbox } = makeMailbox();
    const account = makeAccount();

    const original = await storeEmail(
      ENV,
      account,
      makeEmail({ messageId: '<orig@example.com>', subject: 'Project status' }),
      [],
      undefined,
      mailbox,
    );
    expect(original).not.toBeNull();

    const reply = await storeEmail(
      ENV,
      account,
      makeEmail({
        messageId: '<reply@example.com>',
        subject: 'Re: Project status',
        inReplyTo: '<orig@example.com>',
      }),
      [],
      undefined,
      mailbox,
    );

    expect(reply).not.toBeNull();
    expect(reply!.threadId).toBe(original!.threadId);
  });

  it('is idempotent: redelivering the same Message-ID is a no-op, not a second row', async () => {
    const { mailbox } = makeMailbox();
    const account = makeAccount();
    const email = makeEmail({ messageId: '<dupe@example.com>' });

    const first = await storeEmail(ENV, account, email, [], undefined, mailbox);
    expect(first).not.toBeNull();

    const second = await storeEmail(ENV, account, email, [], undefined, mailbox);
    expect(second).toBeNull();

    const stats = await mailbox.stats();
    expect(stats.total).toBe(1);
  });

  it('returns null when the workspace account has no mailbox store resolved', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await storeEmail(ENV, makeAccount(), makeEmail(), [], undefined, null);
    expect(result).toBeNull();
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// applyMailRules — pure fold of AI labels + mail rules into one state
// ---------------------------------------------------------------------------

type RulesDb = Parameters<typeof applyMailRules>[0];
type RuleRow = Parameters<typeof applyMailRules>[1][number];

function fakeRulesDb(): RulesDb {
  return { update: () => ({ set: () => ({ where: () => Promise.resolve() }) }) } as unknown as RulesDb;
}

function ruleRow(opts: {
  id?: string;
  conditions?: Array<{ field: string; operator: string; value: string }>;
  matchType?: 'all' | 'any';
  actions?: Array<{ type: string; labelId?: string }>;
  stopProcessing?: boolean;
}): RuleRow {
  return {
    id: opts.id ?? 'rule_1',
    accountId: 'acct_1',
    name: opts.id ?? 'rule_1',
    description: null,
    // A condition that matches any non-empty subject by default, so a test
    // can focus on actions/ordering without also having to craft a condition.
    conditions: opts.conditions ?? [{ field: 'subject', operator: 'contains', value: '' }],
    matchType: opts.matchType ?? 'all',
    actions: opts.actions ?? [],
    isActive: true,
    stopProcessing: opts.stopProcessing ?? false,
    priority: 0,
    applyToExisting: false,
    appliedCount: 0,
    lastAppliedAt: null,
    scope: 'incoming',
    folders: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  } as unknown as RuleRow;
}

const BASE_STATE: RuleMessageState = { labels: ['INBOX'], isRead: false, isFlagged: false, isSpam: false, deleted: false };

describe('applyMailRules', () => {
  const email = makeEmail({ subject: 'Invoice #42', textBody: 'please pay' });

  it('applies a matching rule onto the running state', async () => {
    const { state, markedSpam } = await applyMailRules(
      fakeRulesDb(),
      [ruleRow({ actions: [{ type: 'star' }] })],
      email,
      'msg_1',
      BASE_STATE,
    );
    expect(state.labels).toEqual(expect.arrayContaining(['STARRED']));
    expect(markedSpam).toBe(false);
  });

  it('a no-op action (already starred) leaves the state reference unchanged — no finalize write needed', async () => {
    const already: RuleMessageState = { ...BASE_STATE, labels: ['INBOX', 'STARRED'] };
    const { state } = await applyMailRules(fakeRulesDb(), [ruleRow({ actions: [{ type: 'star' }] })], email, 'msg_1', already);
    expect(state).toBe(already);
  });

  it('mark_as_spam moves the message to Spam and reports markedSpam', async () => {
    const { state, markedSpam } = await applyMailRules(
      fakeRulesDb(),
      [ruleRow({ actions: [{ type: 'mark_as_spam' }] })],
      email,
      'msg_1',
      BASE_STATE,
    );
    expect(markedSpam).toBe(true);
    expect(state.labels).toEqual(['SPAM']);
    expect(state.isSpam).toBe(true);
  });

  it('stopProcessing halts rules after it', async () => {
    const rules = [
      ruleRow({ id: 'r1', stopProcessing: true, actions: [{ type: 'flag' }] }),
      ruleRow({ id: 'r2', actions: [{ type: 'star' }] }),
    ];
    const { state } = await applyMailRules(fakeRulesDb(), rules, email, 'msg_1', BASE_STATE);
    expect(state.isFlagged).toBe(true);
    expect(state.labels).not.toContain('STARRED');
  });

  it('matches every rule against one fixed snapshot: a later rule cannot react to an earlier mark_as_spam', async () => {
    const rules = [
      ruleRow({ id: 'r1', actions: [{ type: 'mark_as_spam' }] }),
      ruleRow({
        id: 'r2',
        conditions: [{ field: 'is_spam', operator: 'equals', value: 'true' }],
        actions: [{ type: 'flag' }],
      }),
    ];
    const { state, markedSpam } = await applyMailRules(fakeRulesDb(), rules, email, 'msg_1', BASE_STATE);
    expect(markedSpam).toBe(true);
    // r2's `is_spam` condition reads the ORIGINAL (false) snapshot, not r1's
    // own effect on `next` — exactly like the old code's one `updatedMessage`
    // read before its whole rule loop.
    expect(state.isFlagged).toBe(false);
  });

  it('a rule with no matching condition value never applies', async () => {
    const rules = [ruleRow({ conditions: [{ field: 'subject', operator: 'contains', value: 'nope-does-not-match' }], actions: [{ type: 'flag' }] })];
    const { state } = await applyMailRules(fakeRulesDb(), rules, email, 'msg_1', BASE_STATE);
    expect(state).toBe(BASE_STATE);
  });
});

// ---------------------------------------------------------------------------
// finishWorkspaceDelivery — entity-event publish gated by mailbox.backend
// ---------------------------------------------------------------------------

describe('finishWorkspaceDelivery: email:created publish gating (design task D4)', () => {
  const account = makeAccount();
  const email = makeEmail();
  const stored: StoreEmailResult = { messageId: 'msg_1', threadId: 'msg_1', isSpam: false };

  it('publishes the hub event directly when the mailbox is postgres-backed (today\'s behaviour, unchanged)', async () => {
    const mailbox = { backend: 'postgres' } as unknown as MailboxStore;
    await finishWorkspaceDelivery(ENV, account, email, undefined, stored, 'preview', mailbox);
    expect(publishInboundEmailCreated).toHaveBeenCalledTimes(1);
  });

  it('does not publish directly when the mailbox is object-backed — the object\'s own outbox already did', async () => {
    const mailbox = { backend: 'object' } as unknown as MailboxStore;
    await finishWorkspaceDelivery(ENV, account, email, undefined, stored, 'preview', mailbox);
    expect(publishInboundEmailCreated).not.toHaveBeenCalled();
  });
});
