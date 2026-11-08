import { describe, expect, it } from 'vitest';
import type { DeskConversation, DeskMessage } from './use-desk-queries';
import {
  conversationLanguage,
  customerMessageIds,
  messageTranslationMetadata,
} from './use-desk-translation-queries';

const message = (id: string, values: Partial<DeskMessage>): DeskMessage => ({
  id,
  createdAt: '2026-01-01T09:00:00.000Z',
  conversationId: 'dconv_1',
  kind: 'message',
  body: 'Hallo',
  authorType: 'visitor',
  authorId: null,
  attachments: null,
  metadata: null,
  ...values,
});

describe('desk translation helpers', () => {
  it("translates only the customer's public messages with text", () => {
    const ids = customerMessageIds([
      message('m1', {}),
      message('m2', { authorType: 'agent' }),
      message('m3', { kind: 'note' }),
      message('m4', { body: '   ' }),
      message('m5', { kind: 'event', body: null }),
      message('m6', { pending: 'sending' }),
      message('m7', {}),
    ]);
    expect(ids).toEqual(['m1', 'm7']);
  });

  it('keeps the latest 50', () => {
    const ids = customerMessageIds(Array.from({ length: 60 }, (_, i) => message(`m${i}`, {})));
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe('m10');
  });

  it("reads what the agent wrote from a translated reply's metadata", () => {
    expect(
      messageTranslationMetadata(
        message('m1', {
          authorType: 'agent',
          metadata: { translation: { original: 'Hello', sourceLocale: 'en', targetLocale: 'de' } },
        }),
      ),
    ).toEqual({ original: 'Hello', sourceLocale: 'en', targetLocale: 'de' });
    expect(messageTranslationMetadata(message('m2', {}))).toBeNull();
    expect(messageTranslationMetadata(message('m3', { metadata: { translation: 'Hello' } }))).toBeNull();
  });

  it("reads the conversation's language, which the shared type doesn't name", () => {
    expect(conversationLanguage({ language: 'de' } as unknown as DeskConversation)).toBe('de');
    expect(conversationLanguage({ language: null } as unknown as DeskConversation)).toBeNull();
    expect(conversationLanguage(undefined)).toBeNull();
  });
});
