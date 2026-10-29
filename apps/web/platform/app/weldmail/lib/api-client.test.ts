/**
 * Regression cover for the WeldMail scheduled-send URL.
 *
 * Both compose surfaces used to POST a hand-rolled `/mail/scheduled`, which
 * resolves to `/api/mail/scheduled`. app-api mounts the routes at
 * `/api/mail-scheduled` and has no `/api/mail` mount at all, so every schedule
 * from the web 404'd and surfaced as "Failed to schedule email". Nothing
 * covered this path, which is why it shipped. These tests pin the wire format.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mailApi } from './api-client';

const BASE = 'http://localhost:8789/api';

function mockFetch(body: unknown = { data: { messageId: 'm1' } }, status = 200) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

function lastCall(fn: ReturnType<typeof mockFetch>) {
  const [url, init] = fn.mock.calls.at(-1) as [string, RequestInit];
  return { url, init, body: JSON.parse(String(init.body)) };
}

/** Like `lastCall`, but for GET/DELETE requests that send no body. */
function lastCallNoBody(fn: ReturnType<typeof mockFetch>) {
  const [url, init] = fn.mock.calls.at(-1) as [string, RequestInit];
  return { url, init };
}

const baseArgs = {
  accountId: 'acc_1',
  to: ['someone@example.com'],
  scheduledFor: new Date('2030-01-02T03:04:05.000Z'),
};

describe('mailApi.scheduled', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to the hyphenated /mail-scheduled mount, never /mail/scheduled', async () => {
    const fetchMock = mockFetch();
    await mailApi.scheduled.schedule(baseArgs);

    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(`${BASE}/mail-scheduled`);
    // The exact shape of the original bug — guard it explicitly.
    expect(url).not.toContain('/api/mail/scheduled');
    expect(init.method).toBe('POST');
  });

  it('serialises scheduledFor as an ISO string (route expects z.string().datetime())', async () => {
    const fetchMock = mockFetch();
    await mailApi.scheduled.schedule(baseArgs);

    expect(lastCall(fetchMock).body.scheduledFor).toBe('2030-01-02T03:04:05.000Z');
  });

  it('passes freshly-uploaded attachments through unchanged', async () => {
    const fetchMock = mockFetch();
    const attachments = [
      { filename: 'a.pdf', contentType: 'application/pdf', size: 12, fileKey: 'k/1' },
    ];
    await mailApi.scheduled.schedule({ ...baseArgs, attachments });

    expect(lastCall(fetchMock).body.attachments).toEqual(attachments);
  });

  it('reports failure via the ApiResponse envelope rather than throwing', async () => {
    mockFetch({ error: { code: 'NOT_FOUND', message: 'Message not found' } }, 404);

    const result = await mailApi.scheduled.schedule(baseArgs);
    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toBe('Message not found');
  });

  it('targets the hyphenated mount for cancel / send-now / reschedule too', async () => {
    const fetchMock = mockFetch();

    await mailApi.scheduled.cancel('msg_1');
    expect(lastCall(fetchMock).url).toBe(`${BASE}/mail-scheduled/msg_1/cancel`);

    await mailApi.scheduled.sendNow('msg_1');
    expect(lastCall(fetchMock).url).toBe(`${BASE}/mail-scheduled/msg_1/send-now`);

    await mailApi.scheduled.reschedule('msg_1', new Date('2030-05-06T07:08:09.000Z'));
    const { url, body } = lastCall(fetchMock);
    expect(url).toBe(`${BASE}/mail-scheduled/msg_1/reschedule`);
    expect(body.scheduledFor).toBe('2030-05-06T07:08:09.000Z');
  });
});

describe('mailApi.messages reply / forward attachments', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs reply attachments through to /mail-messages/:id/reply', async () => {
    const fetchMock = mockFetch();
    const attachments = [
      { filename: 'a.pdf', contentType: 'application/pdf', size: 12, fileKey: 'k/1' },
    ];
    await mailApi.messages.reply('acc_1', 'msg_1', { body: 'Thanks', attachments });

    const { url, body } = lastCall(fetchMock);
    expect(url).toBe(`${BASE}/mail-messages/msg_1/reply`);
    expect(body.attachments).toEqual(attachments);
  });

  it('POSTs forward attachments through to /mail-messages/:id/forward', async () => {
    const fetchMock = mockFetch();
    const attachments = [
      { filename: 'a.pdf', contentType: 'application/pdf', size: 12, fileKey: 'k/1' },
    ];
    await mailApi.messages.forward('acc_1', 'msg_1', {
      to: ['other@example.com'],
      body: 'FYI',
      attachments,
    });

    const { url, body } = lastCall(fetchMock);
    expect(url).toBe(`${BASE}/mail-messages/msg_1/forward`);
    expect(body.attachments).toEqual(attachments);
  });
});

describe('mailApi send denials (outbound guard)', () => {
  const denial = {
    error: {
      code: 'SENDING_LIMITED',
      message: 'Hourly limit reached',
      details: { code: 'SENDING_LIMITED', window: 'hour', limit: 30, used: 30, retryAfter: '2030-01-02T04:00:00.000Z' },
    },
  };

  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the code and the details of a refused send, so the compose screen can explain it', async () => {
    mockFetch(denial, 429);
    const result = await mailApi.messages.send('acc_1', { to: ['someone@example.com'], body: 'Hi' });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SENDING_LIMITED');
    expect(result.errorDetails).toEqual(denial.error.details);
  });

  it('does the same for reply, forward and a scheduled send-now', async () => {
    mockFetch(denial, 429);
    const reply = await mailApi.messages.reply('acc_1', 'msg_1', { body: 'Thanks' });
    const forward = await mailApi.messages.forward('acc_1', 'msg_1', { to: ['other@example.com'] });
    const sendNow = await mailApi.scheduled.sendNow('msg_2');

    for (const result of [reply, forward, sendNow]) {
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('SENDING_LIMITED');
      expect(result.errorDetails).toEqual(denial.error.details);
    }
  });

  it('keeps the details of a send-a-draft denial too', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { id: 'd1', accountId: 'acc_1', to: ['someone@example.com'], cc: [], bcc: [], labels: [] } }),
      } as Response)
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => denial } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await mailApi.drafts.send('acc_1', 'd1');
    expect(result).toMatchObject({ success: false, errorCode: 'SENDING_LIMITED', errorDetails: denial.error.details });
  });

  it('reports who got a partially sent message', async () => {
    const details = { sent: ['a@x.com'], failed: ['b@x.com'], messageId: 'msg_1' };
    mockFetch({ error: { code: 'PARTIALLY_SENT', message: 'Sent to 1 of 2 recipients.', details } }, 502);
    const result = await mailApi.messages.send('acc_1', { to: ['a@x.com', 'b@x.com'], body: 'Hi' });

    expect(result.errorCode).toBe('PARTIALLY_SENT');
    expect(result.errorDetails).toEqual(details);
  });
});

describe('mailApi.messages accountId locate hint (mailbox-store design §5)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends ?accountId= on get/update/delete/add-label/remove-label', async () => {
    const fetchMock = mockFetch();

    await mailApi.messages.get('acc_1', 'msg_1');
    expect(lastCallNoBody(fetchMock).url).toBe(`${BASE}/mail-messages/msg_1?accountId=acc_1`);

    await mailApi.messages.update('acc_1', 'msg_1', { isRead: true });
    expect(lastCall(fetchMock).url).toBe(`${BASE}/mail-messages/msg_1?accountId=acc_1`);
    expect(lastCall(fetchMock).init.method).toBe('PATCH');

    await mailApi.messages.delete('acc_1', 'msg_1');
    expect(lastCallNoBody(fetchMock).url).toBe(`${BASE}/mail-messages/msg_1?accountId=acc_1`);
    expect(lastCallNoBody(fetchMock).init.method).toBe('DELETE');

    await mailApi.messages.addLabel('acc_1', 'msg_1', 'STARRED');
    expect(lastCall(fetchMock).url).toBe(`${BASE}/mail-messages/msg_1/labels/add?accountId=acc_1`);

    await mailApi.messages.removeLabel('acc_1', 'msg_1', 'STARRED');
    expect(lastCall(fetchMock).url).toBe(`${BASE}/mail-messages/msg_1/labels/remove?accountId=acc_1`);
  });

  it('omits the hint entirely when the caller has no accountId yet (back-compat fan-out)', async () => {
    const fetchMock = mockFetch();

    await mailApi.messages.get('', 'msg_1');
    expect(lastCallNoBody(fetchMock).url).toBe(`${BASE}/mail-messages/msg_1`);

    await mailApi.messages.delete('', 'msg_1');
    expect(lastCallNoBody(fetchMock).url).toBe(`${BASE}/mail-messages/msg_1`);
  });

  it('carries the hint through every request archive/restore make (labels add then remove)', async () => {
    const fetchMock = mockFetch({ data: { id: 'msg_1', labels: [] } });

    await mailApi.messages.archive('acc_1', 'msg_1');

    const urls = fetchMock.mock.calls.map(([url]) => url as string);
    expect(urls).toEqual([
      `${BASE}/mail-messages/msg_1/labels/add?accountId=acc_1`,
      `${BASE}/mail-messages/msg_1/labels/remove?accountId=acc_1`,
    ]);
  });

  it('carries the hint through restore (adds INBOX)', async () => {
    const fetchMock = mockFetch({ data: { id: 'msg_1', labels: [] } });

    await mailApi.messages.restore('acc_1', 'msg_1');

    expect(lastCall(fetchMock).url).toBe(`${BASE}/mail-messages/msg_1/labels/add?accountId=acc_1`);
  });

  it('carries the hint through spam/unspam (PATCH isSpam)', async () => {
    const fetchMock = mockFetch({ data: { id: 'msg_1' } });

    await mailApi.messages.spam('acc_1', 'msg_1', true);
    expect(lastCall(fetchMock).url).toBe(`${BASE}/mail-messages/msg_1?accountId=acc_1`);
    expect(lastCall(fetchMock).body).toEqual({ isSpam: true });

    await mailApi.messages.spam('acc_1', 'msg_1', false);
    expect(lastCall(fetchMock).url).toBe(`${BASE}/mail-messages/msg_1?accountId=acc_1`);
    expect(lastCall(fetchMock).body).toEqual({ isSpam: false });
  });

  it('carries the hint through trash (the bulk endpoint), as an additive query param', async () => {
    const fetchMock = mockFetch({ data: { affected: 1 } });

    await mailApi.messages.trash('acc_1', 'msg_1');

    const { url, body } = lastCall(fetchMock);
    expect(url).toBe(`${BASE}/mail-messages/bulk?accountId=acc_1`);
    expect(body).toEqual({ messageIds: ['msg_1'], action: 'trash' });
  });

  it('move() forwards the same hint for every action', async () => {
    const fetchMock = mockFetch({ data: { id: 'msg_1', labels: [] } });

    await mailApi.messages.move('acc_1', 'msg_1', 'inbox');
    expect(lastCall(fetchMock).url).toBe(`${BASE}/mail-messages/msg_1/labels/add?accountId=acc_1`);
  });
});
