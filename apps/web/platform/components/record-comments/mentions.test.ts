import { describe, expect, it } from 'vitest';
import { fromChatContent, plainComment, toChatContent } from './mentions';

describe('comment mentions', () => {
  it('writes the comment box\'s mentions as WeldChat tokens, and reads them back', () => {
    const { content, mentions } = toChatContent('  Check @[Bo Smith](user_1) and @[Ann](user_2), @[Bo Smith](user_1) ');
    expect(content).toBe('Check <@user_1:Bo Smith> and <@user_2:Ann>, <@user_1:Bo Smith>');
    expect(mentions).toEqual(['user_1', 'user_2']);
    expect(fromChatContent(content)).toBe('Check @[Bo Smith](user_1) and @[Ann](user_2), @[Bo Smith](user_1)');
  });

  it('shows tokens as names, records by their label, and leaves other tokens for editing', () => {
    const names = new Map([['user_3', 'Cy']]);
    expect(plainComment('Hi <@user_3>, see <@company:cmp_1|Acme>', names)).toBe('Hi @Cy, see @Acme');
    expect(fromChatContent('See <@company:cmp_1|Acme>')).toBe('See <@company:cmp_1|Acme>');
  });
});
