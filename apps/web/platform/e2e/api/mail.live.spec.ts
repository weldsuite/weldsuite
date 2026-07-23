/**
 * LIVE mail send — actually transmits one real email via the Cloudflare
 * `send_email` binding against a DEPLOYED app-api (preview/test). This is the
 * only test in the suite that performs an outward-facing action, so it is
 * OPT-IN and skipped by default.
 *
 * It is NOT part of the normal `api` run's assertions about correctness — the
 * hermetic transmit wiring is covered by
 * `apps/workers/app-api/src/lib/cloudflare-email.test.ts`, and persistence by
 * `e2e/api/mail.spec.ts` (dry-run). This spec exists to prove a real send
 * reaches Cloudflare and is accepted in a deployed environment.
 *
 * Enable by setting (e.g. in the shell, not committed):
 *   MAIL_LIVE=1
 *   MAIL_LIVE_API_URL=https://weldsuite-app-api-preview.<acct>.workers.dev
 *   MAIL_LIVE_TOKEN=<TEST_FIXTURES_TOKEN for that deployment>
 *   MAIL_LIVE_WORKSPACE_ID=<a workspace/org id in that env>
 *   MAIL_LIVE_ACCOUNT_ID=<id of a mail account on a VERIFIED sending domain>
 *   MAIL_LIVE_TO=<recipient you control / a weldsuite inbound address>
 *
 * The `MAIL_LIVE_ACCOUNT_ID` must already exist on a verified sending domain in
 * that workspace — Cloudflare rejects sends from unverified domains. The
 * recipient must be deliverable (Workers Paid) or a verified destination
 * address (free tier), otherwise the send is reported as pending verification.
 */

import { test, expect } from '@playwright/test';

const env = (k: string) => process.env[k] ?? '';
const enabled = process.env.MAIL_LIVE === '1';
const required = ['MAIL_LIVE_API_URL', 'MAIL_LIVE_TOKEN', 'MAIL_LIVE_WORKSPACE_ID', 'MAIL_LIVE_ACCOUNT_ID', 'MAIL_LIVE_TO'];

test.describe('app-api · LIVE mail send (opt-in)', () => {
  test.beforeAll(() => {
    test.skip(!enabled, 'MAIL_LIVE not set — opt-in live send test is disabled');
    const missing = required.filter((k) => !process.env[k]);
    test.skip(missing.length > 0, `Missing live-send env vars: ${missing.join(', ')}`);
  });

  test('sends a real email and Cloudflare accepts it', async ({ request }) => {
    const base = env('MAIL_LIVE_API_URL').replace(/\/$/, '');
    const stamp = new Date().toISOString();

    const res = await request.post(`${base}/test-fixtures/mail/send`, {
      headers: {
        'X-Test-Token': env('MAIL_LIVE_TOKEN'),
        'X-Test-Workspace-Id': env('MAIL_LIVE_WORKSPACE_ID'),
        'Content-Type': 'application/json',
      },
      data: {
        accountId: env('MAIL_LIVE_ACCOUNT_ID'),
        to: [env('MAIL_LIVE_TO')],
        subject: `WeldSuite live send test ${stamp}`,
        body: `This is an automated live-send test sent at ${stamp}.`,
        htmlBody: `<p>This is an automated live-send test sent at <b>${stamp}</b>.</p>`,
        live: true,
      },
    });

    const text = await res.text();
    // Surface the full response so a failure (e.g. unverified domain) is legible.
    expect(res.status(), `Live send failed:\n${text}`).toBe(201);

    const body = JSON.parse(text);
    expect(body.data?.result?.messageId).toBeTruthy();

    const pending = body.data.result.pendingVerification;
    // eslint-disable-next-line no-console
    console.log(
      `[live-send] accepted messageId=${body.data.result.messageId} ` +
        `pendingVerification=${pending} to=${env('MAIL_LIVE_TO')}`,
    );
    // pendingVerification === true means Cloudflare accepted it but the
    // recipient must verify (free-tier first-touch). That's still "accepted";
    // we only fail if the transmit itself errored (non-201 above).
    expect(typeof pending).toBe('boolean');
  });
});
