/**
 * A deterministic stand-in for `../corpus`, used with
 * `vi.mock('../corpus', () => import('../test-support/corpus-stub'))`.
 */

import { vi } from 'vitest';
import type { CorpusPerson, CorpusThread, RenderedCorpusMessage } from '../corpus/types';

export const STUB_THREADS: CorpusThread[] = [
  {
    id: 'stub-001',
    subject: 'Quarterly planning',
    messages: [
      { author: 'starter', body: 'Hi {{recipientFirstName}}, can we plan the quarter? {{senderFirstName}}' },
      { author: 'responder', body: 'Hi {{recipientFirstName}}, yes. {{senderFirstName}}' },
      { author: 'starter', body: 'Great, thanks {{recipientFirstName}}. {{senderFirstName}}' },
      { author: 'responder', body: 'Anytime. {{senderFirstName}}' },
    ],
  },
  {
    id: 'stub-002',
    subject: 'Venue for the offsite',
    messages: [
      { author: 'starter', body: 'Hello {{recipientFirstName}}, any venue ideas? {{senderFirstName}}' },
      { author: 'responder', body: 'Two ideas below. {{senderFirstName}}' },
    ],
  },
  {
    id: 'stub-003',
    subject: 'Invoice question',
    messages: [
      { author: 'starter', body: 'Hi {{recipientFirstName}}, quick invoice question. {{senderFirstName}}' },
      { author: 'responder', body: 'Sure, ask away. {{senderFirstName}}' },
      { author: 'starter', body: 'Thanks, all clear. {{senderFirstName}}' },
    ],
  },
];

export const loadCorpus = vi.fn(async (): Promise<CorpusThread[]> => STUB_THREADS);

export const loadCorpusForLookup = vi.fn(async (): Promise<CorpusThread[]> => STUB_THREADS);

export const refreshCorpus = vi.fn(async (): Promise<{ refreshed: boolean }> => ({ refreshed: false }));

export function renderCorpusMessage(
  thread: CorpusThread,
  step: number,
  sender: CorpusPerson,
  recipient: CorpusPerson,
): RenderedCorpusMessage {
  const message = thread.messages[step];
  if (!message) throw new Error(`step ${step} is out of range for ${thread.id}`);
  const text = message.body
    .replaceAll('{{senderFirstName}}', sender.firstName)
    .replaceAll('{{recipientFirstName}}', recipient.firstName);
  return { subject: step === 0 ? thread.subject : `Re: ${thread.subject}`, text };
}
