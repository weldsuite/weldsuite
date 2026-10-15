import { describe, expect, it, vi } from 'vitest';
import { handleOutboundReviewBatch, handleSendingEventsBatch, type OutboundReviewMessage } from './consumers';
import { classifyOutboundTemplate, type ClassifyTemplateFn } from './review';
import type { StoredVerdict } from './ledger-core';

function message<T>(body: T) {
  return { body, ack: vi.fn(), retry: vi.fn() };
}

function batch<T>(queue: string, bodies: T[]) {
  const messages = bodies.map(message);
  return { queue, messages, ackAll: vi.fn(), retryAll: vi.fn() };
}

const review: OutboundReviewMessage = {
  subject: { kind: 'workspace', workspaceId: 'ws_1', clerkOrgId: 'org_1' },
  request: {
    fingerprint: '00ff00ff00ff00ff',
    sample: 'hi tokname quick question would you be open to a call',
    subject: 'Quick question',
    reason: 'template_threshold',
    firstContactRecipients: 12,
    recipients: 12,
    sources: ['crm_sequence'],
    domains: ['x.com'],
    trustLevel: 'new',
  },
  requestedAt: '2026-10-13T10:00:00.000Z',
};

describe('handleOutboundReviewBatch', () => {
  it('hands the verdict to the workspace ledger and acks', async () => {
    const verdict: StoredVerdict = {
      fingerprint: review.request.fingerprint,
      category: 'cold_outreach',
      unsolicited: true,
      confidence: 0.9,
      signals: ['meeting request'],
      modelId: 'test',
      reviewedAt: '2026-10-13T10:00:01.000Z',
    };
    const classify = vi.fn<ClassifyTemplateFn>().mockResolvedValue(verdict);
    const recordVerdict = vi.fn();
    const names: string[] = [];
    const env = {
      OUTBOUND_LEDGER: {
        idFromName: (n: string) => (names.push(n), n),
        get: () => ({ recordVerdict }),
      } as unknown as DurableObjectNamespace<never>,
    };
    const b = batch('mail-outbound-review-test', [review]);
    await handleOutboundReviewBatch(b as unknown as MessageBatch<OutboundReviewMessage>, env as never, classify);
    expect(classify).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ subject: 'Quick question', context: expect.objectContaining({ sources: ['crm_sequence'], trustLevel: 'new' }) }),
      { workspaceId: 'ws_1', fingerprint: '00ff00ff00ff00ff' },
    );
    expect(names).toEqual(['ws:ws_1']);
    expect(recordVerdict).toHaveBeenCalledWith(verdict, { staffRequested: false });
    expect(b.messages[0]!.ack).toHaveBeenCalled();
  });

  it('acks without a verdict (the heuristics carry on)', async () => {
    const b = batch('mail-outbound-review-test', [review]);
    await handleOutboundReviewBatch(b as unknown as MessageBatch<OutboundReviewMessage>, {}, vi.fn<ClassifyTemplateFn>().mockResolvedValue(null));
    expect(b.messages[0]!.ack).toHaveBeenCalled();
  });
});

describe('classifyOutboundTemplate', () => {
  it('returns null when the AI gateway is not configured', async () => {
    expect(
      await classifyOutboundTemplate({}, { subject: 's', text: 'some text', context: { firstContactRecipients: 1, recipients: 1, sources: [], trustLevel: 'new' } }, { workspaceId: null, fingerprint: 'f' }),
    ).toBeNull();
  });

  it('returns null for an empty sample', async () => {
    expect(
      await classifyOutboundTemplate({}, { subject: 's', text: '   ', context: { firstContactRecipients: 1, recipients: 1, sources: [], trustLevel: 'new' } }, { workspaceId: null, fingerprint: 'f' }),
    ).toBeNull();
  });
});

describe('handleSendingEventsBatch', () => {
  it('acks malformed and foreign messages without touching anything', async () => {
    const b = batch('mail-sending-events-test', [{ type: 'cf.r2.bucket.created' }, 'garbage']);
    await handleSendingEventsBatch(b as unknown as MessageBatch<unknown>, {} as never);
    expect(b.ackAll).toHaveBeenCalled();
    expect(b.retryAll).not.toHaveBeenCalled();
  });
});
