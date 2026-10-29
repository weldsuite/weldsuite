import { describe, expect, it } from 'vitest';
import { dropFileTokens, encodeEntityToken, encodeFileToken, fileTokenIds, parseChatTokens } from './render-tokens';

describe('file tokens', () => {
  it('parses <@file:id> as an inline attachment, not a user', () => {
    expect(parseChatTokens('a <@file:att_1> b')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'file', attachmentId: 'att_1' },
      { kind: 'text', text: ' b' },
    ]);
  });

  it('keeps a token without an id as text', () => {
    expect(parseChatTokens('<@file:>')).toEqual([{ kind: 'text', text: '<@file:>' }]);
  });

  it('encodes the token the parser reads', () => {
    expect(fileTokenIds(`${encodeFileToken('att_1')} x ${encodeFileToken('att_2')} ${encodeFileToken('att_1')}`)).toEqual([
      'att_1',
      'att_2',
    ]);
  });

  it('drops only the file tokens it is told to, leaving mentions alone', () => {
    expect(dropFileTokens('<@user_1> <@file:att_1> <@file:att_2>', (id) => id === 'att_2')).toBe(
      '<@user_1>  <@file:att_2>',
    );
  });
});

describe('record tokens', () => {
  it('parses <@sheet:id|Label> as a spreadsheet reference, not a user', () => {
    expect(parseChatTokens('see <@sheet:sht_1|Budget 2026> now')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'entity', entityType: 'sheet', entityId: 'sht_1', label: 'Budget 2026' },
      { kind: 'text', text: ' now' },
    ]);
  });

  it('round-trips the token the composer inserts for a picked spreadsheet', () => {
    const token = encodeEntityToken('sheet', 'sht_1', 'Q3 | plan > draft');
    expect(token).toBe('<@sheet:sht_1|Q3  plan  draft>');
    expect(parseChatTokens(token)).toEqual([
      { kind: 'entity', entityType: 'sheet', entityId: 'sht_1', label: 'Q3  plan  draft' },
    ]);
  });

  it('still reads a token with an unknown type word as a user with a name', () => {
    expect(parseChatTokens('<@worksheet:Plan>')).toEqual([
      { kind: 'user', userId: 'worksheet', displayName: 'Plan' },
    ]);
  });
});
