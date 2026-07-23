import {
  splitAddresses,
  resolveRecipients,
  resolveOptionalRecipients,
  buildQuotedSuffix,
  mapContactSuggestions,
  buildSendPayload,
  buildScheduledPayload,
  sendThenQueueOnOffline,
  type ComposePayloadInput,
  type UploadedAttachment,
} from '../compose-helpers';
import { NetworkError } from '@weldsuite/api-client/client';

/** A baseline compose state: one To recipient, plain-text body, no cc/bcc. */
function baseInput(overrides: Partial<ComposePayloadInput> = {}): ComposePayloadInput {
  return {
    toRecipients: ['to@x.com'],
    to: '',
    ccRecipients: [],
    cc: '',
    bccRecipients: [],
    bcc: '',
    subject: 'Hello',
    body: 'Plain body',
    bodyHtml: '',
    quotedSuffix: '',
    ...overrides,
  };
}

const ATTACHMENT: UploadedAttachment = {
  filename: 'a.pdf',
  contentType: 'application/pdf',
  size: 100,
  fileKey: 'workspaces/w/a.pdf',
};

describe('splitAddresses', () => {
  it('splits on commas and semicolons and trims/drops empties', () => {
    expect(splitAddresses('a@x.com, b@x.com;c@x.com')).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
    expect(splitAddresses('  ')).toEqual([]);
    expect(splitAddresses('')).toEqual([]);
    expect(splitAddresses('a@x.com,,')).toEqual(['a@x.com']);
  });
});

describe('resolveRecipients (required)', () => {
  it('prefers chips, else parses raw, else empty array', () => {
    expect(resolveRecipients(['a@x.com'], 'ignored@x.com')).toEqual(['a@x.com']);
    expect(resolveRecipients([], 'b@x.com, c@x.com')).toEqual(['b@x.com', 'c@x.com']);
    expect(resolveRecipients([], '')).toEqual([]);
  });
});

describe('resolveOptionalRecipients (cc/bcc)', () => {
  it('prefers chips, else parses raw, else undefined when blank', () => {
    expect(resolveOptionalRecipients(['a@x.com'], '')).toEqual(['a@x.com']);
    expect(resolveOptionalRecipients([], 'b@x.com')).toEqual(['b@x.com']);
    expect(resolveOptionalRecipients([], '   ')).toBeUndefined();
    expect(resolveOptionalRecipients([], '')).toBeUndefined();
  });
});

describe('buildQuotedSuffix', () => {
  const params = { quotedBody: 'hello body', quotedFrom: 'Ada (ada@x.com)', quotedSubject: 'Hi' };

  it('is empty outside reply/forward or without a quoted body', () => {
    expect(buildQuotedSuffix(undefined, params)).toBe('');
    expect(buildQuotedSuffix('reply', { quotedBody: '' })).toBe('');
  });

  it('uses "Original message" for reply/replyAll', () => {
    const out = buildQuotedSuffix('reply', params);
    expect(out).toContain('---------- Original message ---------');
    expect(out).toContain('From: Ada (ada@x.com)');
    expect(out).toContain('Subject: Hi');
    expect(out).toContain('hello body');
  });

  it('uses "Forwarded message" for forward', () => {
    expect(buildQuotedSuffix('forward', params)).toContain('---------- Forwarded message ---------');
  });

  it('tolerates missing from/subject', () => {
    const out = buildQuotedSuffix('reply', { quotedBody: 'b' });
    expect(out).toContain('From: \nSubject: \n');
  });
});

describe('mapContactSuggestions', () => {
  it('maps a { data: [...] } envelope', () => {
    expect(
      mapContactSuggestions({ data: [{ id: '1', email: 'a@x.com', fullName: 'Ann', company: 'X' }] }),
    ).toEqual([{ id: '1', email: 'a@x.com', name: 'Ann', company: 'X' }]);
  });

  it('maps a bare array', () => {
    expect(mapContactSuggestions([{ id: '2', email: 'b@x.com' }])).toEqual([
      { id: '2', email: 'b@x.com', name: 'b@x.com', company: null },
    ]);
  });

  it('builds the name from first/last, then email, then empty', () => {
    expect(mapContactSuggestions([{ id: '3', firstName: 'Jo', lastName: 'Lee', email: 'j@x.com' }])[0].name).toBe('Jo Lee');
    expect(mapContactSuggestions([{ id: '4', email: 'e@x.com' }])[0].name).toBe('e@x.com');
    expect(mapContactSuggestions([{ id: '5' }])[0].name).toBe('');
    expect(mapContactSuggestions([{ id: '5' }])[0].email).toBe('');
  });

  it('returns [] for null / empty / no-data input', () => {
    expect(mapContactSuggestions(null)).toEqual([]);
    expect(mapContactSuggestions({})).toEqual([]);
  });
});

describe('buildSendPayload', () => {
  it('carries to / cc / bcc through (chips and raw fallbacks)', () => {
    const payload = buildSendPayload(
      baseInput({
        toRecipients: ['to@x.com'],
        ccRecipients: ['cc@x.com'],
        bcc: 'bcc1@x.com, bcc2@x.com', // raw fallback (no chips)
      }),
      [],
    );
    expect(payload.to).toEqual(['to@x.com']);
    expect(payload.cc).toEqual(['cc@x.com']);
    expect(payload.bcc).toEqual(['bcc1@x.com', 'bcc2@x.com']);
  });

  it('omits cc / bcc entirely when there are none', () => {
    const payload = buildSendPayload(baseInput(), []);
    expect(payload.cc).toBeUndefined();
    expect(payload.bcc).toBeUndefined();
  });

  it('sends plain text as body (htmlBody undefined) when not in HTML mode', () => {
    const payload = buildSendPayload(baseInput({ body: 'just text', bodyHtml: '' }), []);
    expect(payload.body).toBe('just text');
    expect(payload.htmlBody).toBeUndefined();
  });

  it('sends HTML as htmlBody (body undefined) when in HTML mode', () => {
    const payload = buildSendPayload(baseInput({ body: 'ignored', bodyHtml: '<p>rich</p>' }), []);
    expect(payload.htmlBody).toBe('<p>rich</p>');
    expect(payload.body).toBeUndefined();
  });

  it('appends the quoted reply/forward suffix to the body', () => {
    const payload = buildSendPayload(baseInput({ body: 'My reply', quotedSuffix: '\n\n---- quoted ----' }), []);
    expect(payload.body).toBe('My reply\n\n---- quoted ----');
  });

  it('defaults a blank subject to "(No subject)" and trims', () => {
    expect(buildSendPayload(baseInput({ subject: '   ' }), []).subject).toBe('(No subject)');
    expect(buildSendPayload(baseInput({ subject: '  Hi  ' }), []).subject).toBe('Hi');
  });

  it('includes attachments only when present', () => {
    expect(buildSendPayload(baseInput(), []).attachments).toBeUndefined();
    expect(buildSendPayload(baseInput(), [ATTACHMENT]).attachments).toEqual([ATTACHMENT]);
  });

  it('leaves body undefined when both text and html are empty', () => {
    const payload = buildSendPayload(baseInput({ body: '', bodyHtml: '', quotedSuffix: '' }), []);
    expect(payload.body).toBeUndefined();
    expect(payload.htmlBody).toBeUndefined();
  });
});

describe('buildScheduledPayload', () => {
  const ISO = '2026-01-02T03:04:05.000Z';

  it('includes accountId and scheduledFor', () => {
    const payload = buildScheduledPayload(baseInput(), 'acc_1', ISO);
    expect(payload.accountId).toBe('acc_1');
    expect(payload.scheduledFor).toBe(ISO);
  });

  it('carries cc / bcc like the immediate send', () => {
    const payload = buildScheduledPayload(
      baseInput({ ccRecipients: ['cc@x.com'], bccRecipients: ['bcc@x.com'] }),
      'acc_1',
      ISO,
    );
    expect(payload.cc).toEqual(['cc@x.com']);
    expect(payload.bcc).toEqual(['bcc@x.com']);
  });

  it('uses undefined (not "(No subject)") for a blank subject', () => {
    expect(buildScheduledPayload(baseInput({ subject: '  ' }), 'acc_1', ISO).subject).toBeUndefined();
  });

  it('always sets body, and htmlBody only in HTML mode', () => {
    const plain = buildScheduledPayload(baseInput({ body: 'txt', bodyHtml: '' }), 'acc_1', ISO);
    expect(plain.body).toBe('txt');
    expect(plain.htmlBody).toBeUndefined();

    const html = buildScheduledPayload(baseInput({ body: 'x', bodyHtml: '<b>h</b>' }), 'acc_1', ISO);
    expect(html.body).toBe('<b>h</b>');
    expect(html.htmlBody).toBe('<b>h</b>');
  });
});

describe('sendThenQueueOnOffline', () => {
  it('sends and reports "sent" when online — never queues', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const queue = jest.fn().mockResolvedValue(undefined);
    await expect(sendThenQueueOnOffline({ send, queue })).resolves.toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue).not.toHaveBeenCalled();
  });

  it('queues and reports "queued" when the send fails with a NetworkError', async () => {
    const send = jest.fn().mockRejectedValue(new NetworkError('offline'));
    const queue = jest.fn().mockResolvedValue(undefined);
    await expect(sendThenQueueOnOffline({ send, queue })).resolves.toBe('queued');
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it('rethrows a non-network (server) error and does NOT queue', async () => {
    const send = jest.fn().mockRejectedValue(new Error('400 bad request'));
    const queue = jest.fn().mockResolvedValue(undefined);
    await expect(sendThenQueueOnOffline({ send, queue })).rejects.toThrow('400 bad request');
    expect(queue).not.toHaveBeenCalled();
  });
});
