import { describe, expect, it } from 'vitest';
import { chatTitleFrom } from './chat-title';

describe('a chat name from its first message', () => {
  it('is the message on one line', () => {
    expect(chatTitleFrom('  Show my\n\nopen   tasks ')).toBe('Show my open tasks');
  });

  it('names a tagged record instead of showing its token', () => {
    expect(chatTitleFrom('Add totals to <@sheet:sht_1|Budget>')).toBe('Add totals to @Budget');
  });

  it('is cut to 60 characters', () => {
    expect(chatTitleFrom('a'.repeat(80))).toHaveLength(60);
  });

  it('is empty for a message without text, so the caller can fall back', () => {
    expect(chatTitleFrom('   ')).toBe('');
  });
});
