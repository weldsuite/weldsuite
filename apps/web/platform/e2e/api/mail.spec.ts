/**
 * API-level coverage for the WeldMail outbound path (compose / reply / forward)
 * and attachment handling, exercised directly against app-api.
 *
 * Runs in the `api` Playwright project (no browser, no Clerk session). The real
 * `/api/mail-accounts/:id/send` route is Clerk-protected, so these tests drive
 * the SAME underlying services (`sendAndPersist` / `replyAndPersist` /
 * `forwardAndPersist`) through the test-token-gated `/test-fixtures/mail/*`
 * endpoints in DRY-RUN mode: every step runs for real (format validation, R2
 * attachment resolution + size cap, SENT-message + attachment-row persistence,
 * threading) except the live MX lookup and the Cloudflare transmit. The
 * fixtures return the persisted rows so we can assert cc/bcc/attachment
 * persistence end-to-end — which is exactly what real delivery would store.
 *
 * Reading the result back through the Clerk-protected GET routes is covered by
 * the platform (chromium) E2E suite, which has a real session.
 */

import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  isTestFixturesConfigured,
  testFixtures,
  type SeededMailMessage,
} from '../helpers/test-fixtures-client';

const baseURL = () => process.env.TEST_API_URL?.replace(/\/$/, '') ?? '';
const token = () => process.env.TEST_FIXTURES_TOKEN ?? '';
const workspaceId = () => process.env.TEST_WORKSPACE_ID ?? '';
const headers = () => ({
  'X-Test-Token': token(),
  'X-Test-Workspace-Id': workspaceId(),
  'Content-Type': 'application/json',
});
/** R2 key prefix the send path requires for in-workspace attachments. */
const wsKey = (name: string) => `workspaces/${workspaceId()}/e2e/${name}`;

/** Raw POST to a fixtures endpoint (used for error-path assertions where we
 * need the status + error.code, not a thrown client error). */
function postFixture(
  request: APIRequestContext,
  path: string,
  data: Record<string, unknown>,
) {
  return request.post(`${baseURL()}${path}`, { headers: headers(), data });
}

test.describe('app-api · WeldMail send / reply / forward', () => {
  // One shared mail account reused across the spec so we don't accumulate
  // throwaway accounts. Created via the first dry-run send (which makes a
  // shared account when none is passed).
  let accountId = '';
  let accountEmail = '';
  const messageIds: string[] = [];

  test.beforeAll(async () => {
    test.skip(!isTestFixturesConfigured(), 'test-fixtures env vars not set');
    const boot = await testFixtures.mailSend({ to: ['bootstrap@example.com'], subject: 'boot' });
    accountId = boot.accountId ?? boot.result.accountId;
    accountEmail = boot.message.from.email;
    messageIds.push(boot.result.messageId);
  });

  test.afterAll(async () => {
    if (!isTestFixturesConfigured()) return;
    for (const id of messageIds) {
      await testFixtures.deleteEntity('mailMessage', id).catch(() => {});
    }
    if (accountId) {
      await testFixtures.deleteEntity('mailAccount', accountId).catch(() => {});
    }
  });

  // ---------------------------------------------------------------------------
  // Compose — cc / bcc persistence
  // ---------------------------------------------------------------------------

  test('send persists to / cc / bcc as JSONB on the SENT copy', async () => {
    const res = await testFixtures.mailSend({
      accountId,
      to: ['alice@example.com', 'amy@example.com'],
      cc: ['carl@example.com'],
      bcc: ['bob@example.com'],
      subject: 'CC/BCC test',
      body: 'hello',
    });
    messageIds.push(res.result.messageId);

    expect(res.message.to.map((a) => a.email)).toEqual(['alice@example.com', 'amy@example.com']);
    expect(res.message.cc?.map((a) => a.email)).toEqual(['carl@example.com']);
    expect(res.message.bcc?.map((a) => a.email)).toEqual(['bob@example.com']);
    expect(res.message.subject).toBe('CC/BCC test');
    expect(res.message.labels).toContain('SENT');
    expect(res.message.source).toBe('sent');
    expect(res.message.isRead).toBe(true);
    expect(res.result.pendingVerification).toBe(false);
  });

  test('send without cc/bcc leaves those columns null', async () => {
    const res = await testFixtures.mailSend({
      accountId,
      to: ['solo@example.com'],
      subject: 'No cc',
    });
    messageIds.push(res.result.messageId);

    expect(res.message.cc).toBeNull();
    expect(res.message.bcc).toBeNull();
    expect(res.message.hasAttachments).toBe(false);
    expect(res.message.attachmentCount ?? 0).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Compose — attachments
  // ---------------------------------------------------------------------------

  test('send with attachments resolves them from R2 and persists rows', async () => {
    const res = await testFixtures.mailSend({
      accountId,
      to: ['rcpt@example.com'],
      subject: 'With files',
      body: 'see attached',
      attachments: [
        { filename: 'report.pdf', contentType: 'application/pdf', size: 2048, fileKey: wsKey('report.pdf') },
        { filename: 'logo.png', contentType: 'image/png', size: 1024, fileKey: wsKey('logo.png') },
      ],
    });
    messageIds.push(res.result.messageId);

    expect(res.message.hasAttachments).toBe(true);
    expect(res.message.attachmentCount).toBe(2);
    expect(res.attachments).toHaveLength(2);

    const byName = Object.fromEntries(res.attachments.map((a) => [a.fileName, a]));
    expect(byName['report.pdf'].size).toBe(2048);
    expect(byName['report.pdf'].storagePath).toBe(wsKey('report.pdf'));
    expect(byName['logo.png'].contentType).toBe('image/png');
  });

  test('send rejects an attachment whose fileKey is outside the workspace', async ({ request }) => {
    const res = await postFixture(request, '/test-fixtures/mail/send', {
      accountId,
      to: ['rcpt@example.com'],
      attachments: [{ filename: 'evil.txt', size: 10, fileKey: 'workspaces/org_someone_else/evil.txt' }],
      seedObjects: false,
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error?.code).toBe('ATTACHMENT_NOT_IN_WORKSPACE');
  });

  test('send rejects an attachment that is not in storage', async ({ request }) => {
    const res = await postFixture(request, '/test-fixtures/mail/send', {
      accountId,
      to: ['rcpt@example.com'],
      // Correctly-prefixed key, but we don't seed the R2 object.
      attachments: [{ filename: 'ghost.txt', size: 10, fileKey: wsKey('ghost.txt') }],
      seedObjects: false,
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error?.code).toBe('ATTACHMENT_NOT_IN_STORAGE');
  });

  test('send enforces the 5 MB total size cap', async ({ request }) => {
    const res = await postFixture(request, '/test-fixtures/mail/send', {
      accountId,
      to: ['rcpt@example.com'],
      attachments: [{ filename: 'huge.bin', size: 6 * 1024 * 1024, fileKey: wsKey('huge.bin') }],
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error?.code).toBe('EMAIL_TOO_LARGE');
  });

  // ---------------------------------------------------------------------------
  // Compose — validation
  // ---------------------------------------------------------------------------

  test('send rejects a malformed recipient address', async ({ request }) => {
    const res = await postFixture(request, '/test-fixtures/mail/send', {
      accountId,
      to: ['not-an-email'],
      subject: 'bad',
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error?.code).toBe('INVALID_RECIPIENTS');
    expect(body.error?.details?.invalidFormat).toContain('not-an-email');
  });

  test('send rejects an empty recipient list (schema validation)', async ({ request }) => {
    const res = await postFixture(request, '/test-fixtures/mail/send', {
      accountId,
      to: [],
    });
    expect(res.status()).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // Reply
  // ---------------------------------------------------------------------------

  test('reply threads onto the original and prefixes the subject with Re:', async () => {
    const original = await seedInbox({
      accountId,
      subject: 'Quarterly numbers',
      fromEmail: 'sender@external.test',
      to: [accountEmail],
    });

    const res = await testFixtures.mailReply({
      originalMessageId: original.id,
      body: 'Thanks, looks good.',
    });
    messageIds.push(original.id, res.result.messageId);

    expect(res.message.subject).toBe('Re: Quarterly numbers');
    expect(res.message.to.map((a) => a.email)).toContain('sender@external.test');
    expect(res.message.inReplyTo).toBe(original.messageId);
    expect(res.message.isReply).toBe(true);
    // Thread stitching: the reply inherits the original's thread id.
    expect(res.message.threadId).toBe(original.threadId);
  });

  test('replyAll includes the original To recipients (minus our own address)', async () => {
    const original = await seedInbox({
      accountId,
      subject: 'Team sync',
      fromEmail: 'sender@external.test',
      to: [accountEmail, 'teammate@external.test'],
    });

    const res = await testFixtures.mailReply({
      originalMessageId: original.id,
      body: 'Replying to all',
      replyAll: true,
    });
    messageIds.push(original.id, res.result.messageId);

    const recipients = res.message.to.map((a) => a.email);
    expect(recipients).toContain('sender@external.test');
    expect(recipients).toContain('teammate@external.test');
    // Our own account address must not be echoed back as a recipient.
    expect(recipients).not.toContain(accountEmail);
  });

  // ---------------------------------------------------------------------------
  // Forward
  // ---------------------------------------------------------------------------

  test('forward prefixes Fwd:, quotes the original, and targets new recipients', async () => {
    const original = await seedInbox({
      accountId,
      subject: 'Invoice 42',
      fromEmail: 'billing@external.test',
      to: [accountEmail],
      textBody: 'Please find invoice 42 attached.',
    });

    const res = await testFixtures.mailForward({
      originalMessageId: original.id,
      to: ['colleague@example.com'],
      body: 'FYI — see below.',
    });
    messageIds.push(original.id, res.result.messageId);

    expect(res.message.subject).toBe('Fwd: Invoice 42');
    expect(res.message.to.map((a) => a.email)).toEqual(['colleague@example.com']);
    expect(res.message.textBody).toContain('FYI — see below.');
    expect(res.message.textBody).toContain('Forwarded message');
    expect(res.message.textBody).toContain('Please find invoice 42 attached.');
  });

  test('forward carries attachments through to the new message', async () => {
    const original = await seedInbox({
      accountId,
      subject: 'Spec sheet',
      fromEmail: 'eng@external.test',
      to: [accountEmail],
      textBody: 'Spec attached.',
    });

    const res = await testFixtures.mailForward({
      originalMessageId: original.id,
      to: ['colleague@example.com'],
      attachments: [{ filename: 'spec.pdf', contentType: 'application/pdf', size: 512, fileKey: wsKey('fwd-spec.pdf') }],
    });
    messageIds.push(original.id, res.result.messageId);

    expect(res.message.hasAttachments).toBe(true);
    expect(res.attachments).toHaveLength(1);
    expect(res.attachments[0].fileName).toBe('spec.pdf');
  });

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  async function seedInbox(input: {
    accountId: string;
    subject: string;
    fromEmail: string;
    to: string[];
    textBody?: string;
  }): Promise<SeededMailMessage> {
    return testFixtures.seedMailMessage(input);
  }
});
