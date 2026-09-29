import {
  detectMentionQuery,
  insertMention,
  mentionLabel,
  mentionsToPlainText,
} from '../mentions';

describe('detectMentionQuery', () => {
  it('opens on a bare @ at the start, after a space or after a newline', () => {
    expect(detectMentionQuery('@')).toBe('');
    expect(detectMentionQuery('hey @ra')).toBe('ra');
    expect(detectMentionQuery('first line\n@ga')).toBe('ga');
  });

  it('stays closed for e-mail addresses and finished mentions', () => {
    expect(detectMentionQuery('mail me at bob@example')).toBeNull();
    expect(detectMentionQuery('hey @ra ')).toBeNull();
    expect(detectMentionQuery('no mention here')).toBeNull();
  });
});

describe('insertMention', () => {
  it('replaces the trailing @query with a token', () => {
    expect(insertMention('hey @ra', 'user_1')).toBe('hey <@user_1> ');
    expect(insertMention('@', 'user_1')).toBe('<@user_1> ');
  });
});

describe('mention labels', () => {
  const members = new Map([['user_1', 'Rananjay']]);

  it('resolves user ids, inline labels and entity labels', () => {
    expect(mentionLabel('user_1', members)).toBe('Rananjay');
    expect(mentionLabel('user_2:Ganesh', members)).toBe('Ganesh');
    expect(mentionLabel('ticket:tkt_1|Broken recordings', members)).toBe('Broken recordings');
    expect(mentionLabel('user_missing', members)).toBe('unknown');
  });

  it('flattens tokens for one-line previews', () => {
    expect(mentionsToPlainText('<@user_1> do this asap', members)).toBe('@Rananjay do this asap');
  });
});
