import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectExportedSentRecipients,
  fetchMailboxModes,
  forEachExportedSentMessage,
  isObjectBackedMode,
  mailStoreAdminConfigFromEnv,
  type MailStoreAdminConfig,
} from './mail-store-client';
import type { Window } from './tenant-queries';

const config: MailStoreAdminConfig = { baseUrl: 'https://mail-api-test.weldsuite.org', secret: 's'.repeat(40), adminEmail: 'ops@weldsuite.org' };
const ref = { workspaceId: 'ws_1', accountId: 'mail_1' };
const window: Window = { since: new Date('2026-01-01T00:00:00Z'), until: new Date('2026-01-31T23:59:59Z') };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sentMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    accountId: 'mail_1',
    subject: 'Hi there',
    to: [{ email: 'a@example.com', name: 'A' }],
    cc: null,
    bcc: null,
    inReplyTo: null,
    isReply: false,
    isForwarded: false,
    sentDate: '2026-01-15T12:00:00.000Z',
    source: 'sent',
    sendStatus: null,
    isDraft: false,
    ...overrides,
  };
}

describe('mailStoreAdminConfigFromEnv', () => {
  it('reads the three variables, trimming and dropping a trailing slash', () => {
    expect(
      mailStoreAdminConfigFromEnv({
        MAIL_STORE_ADMIN_URL: ' https://mail-api-test.weldsuite.org/ ',
        OUTBOUND_ADMIN_SECRET: ' secret ',
        MAIL_STORE_ADMIN_EMAIL: ' ops@weldsuite.org ',
      } as NodeJS.ProcessEnv),
    ).toEqual({ baseUrl: 'https://mail-api-test.weldsuite.org', secret: 'secret', adminEmail: 'ops@weldsuite.org' });
  });

  it('is null when any variable is missing', () => {
    expect(mailStoreAdminConfigFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(mailStoreAdminConfigFromEnv({ MAIL_STORE_ADMIN_URL: 'x', OUTBOUND_ADMIN_SECRET: 'y' } as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('isObjectBackedMode', () => {
  it('is true only for object and object-only', () => {
    expect(isObjectBackedMode('object')).toBe(true);
    expect(isObjectBackedMode('object-only')).toBe(true);
    expect(isObjectBackedMode('postgres')).toBe(false);
    expect(isObjectBackedMode('shadow')).toBe(false);
    expect(isObjectBackedMode(null)).toBe(false);
  });
});

describe('fetchMailboxModes', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('maps a status row to its mode and a failed row to an error', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        data: [
          { accountId: 'mail_1', status: { mode: 'object-only', ready: true } },
          { accountId: 'mail_2', error: 'boom' },
        ],
      }),
    );

    const rows = await fetchMailboxModes(config, 'ws_1');
    expect(rows).toEqual([
      { accountId: 'mail_1', mode: 'object-only', error: null },
      { accountId: 'mail_2', mode: null, error: 'boom' },
    ]);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://mail-api-test.weldsuite.org/status/all?workspaceId=ws_1',
      expect.objectContaining({ headers: { 'x-admin-secret': config.secret, 'x-admin-email': config.adminEmail } }),
    );
  });

  it('throws on a non-OK response without the response body', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'nope' } }, 401));
    await expect(fetchMailboxModes(config, 'ws_1')).rejects.toThrow('HTTP 401');
  });

  it('throws when a status row does not match the expected shape', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ data: [{ accountId: 'mail_1' }] }));
    await expect(fetchMailboxModes(config, 'ws_1')).rejects.toThrow();
  });
});

describe('forEachExportedSentMessage / collectExportedSentRecipients', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('pages through the cursor until the response has none, calling onRow per matching row', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ data: { data: [sentMessage({ id: 'm1' })], cursor: 'm1' } }))
      .mockResolvedValueOnce(jsonResponse({ data: { data: [sentMessage({ id: 'm2' })], cursor: null } }));

    const rows: string[] = [];
    await forEachExportedSentMessage(config, ref, window, (row) => rows.push(row.id));

    expect(rows).toEqual(['m1', 'm2']);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]![0]).toBe(
      'https://mail-api-test.weldsuite.org/export?workspaceId=ws_1&accountId=mail_1&sentOnly=true&limit=500',
    );
    expect(fetchSpy.mock.calls[1]![0]).toBe(
      'https://mail-api-test.weldsuite.org/export?workspaceId=ws_1&accountId=mail_1&sentOnly=true&limit=500&cursor=m1',
    );
  });

  it('never returns body text even if the server somehow sent it', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ data: { data: [sentMessage()], cursor: null } }));
    const rows: Array<{ textBody: string | null; htmlBody: string | null }> = [];
    await forEachExportedSentMessage(config, ref, window, (row) => rows.push(row));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ textBody: null, htmlBody: null });
  });

  it('drops rows outside the window, not sent, drafts, or scheduled/cancelled/failed', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        data: {
          data: [
            sentMessage({ id: 'in-window' }),
            sentMessage({ id: 'before-window', sentDate: '2025-12-01T00:00:00.000Z' }),
            sentMessage({ id: 'after-window', sentDate: '2026-02-01T00:00:00.000Z' }),
            sentMessage({ id: 'not-sent', source: 'inbound' }),
            sentMessage({ id: 'draft', isDraft: true }),
            sentMessage({ id: 'scheduled', sendStatus: 'scheduled' }),
            sentMessage({ id: 'cancelled', sendStatus: 'cancelled' }),
            sentMessage({ id: 'failed', sendStatus: 'failed' }),
          ],
          cursor: null,
        },
      }),
    );

    const ids: string[] = [];
    await forEachExportedSentMessage(config, ref, window, (row) => ids.push(row.id));
    expect(ids).toEqual(['in-window']);
  });

  it('collects recipient addresses from to/cc/bcc across every page', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        data: {
          data: [
            sentMessage({
              id: 'm1',
              to: [{ email: 'A@Example.com' }],
              cc: [{ email: 'b@example.com' }],
              bcc: [{ email: 'c@example.com' }],
            }),
          ],
          cursor: null,
        },
      }),
    );

    const into = new Set<string>();
    await collectExportedSentRecipients(config, ref, window, into);
    expect(into).toEqual(new Set(['a@example.com', 'b@example.com', 'c@example.com']));
  });
});
