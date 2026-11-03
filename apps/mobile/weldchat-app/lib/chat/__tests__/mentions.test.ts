import {
  detectMentionQuery,
  fileTokenId,
  fileTokenIds,
  insertMention,
  isAgentId,
  mentionLabel,
  mentionsToPlainText,
  splitInlineFiles,
  stripFileTokens,
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

  it('resolves an agent mention once its name is merged into the map', () => {
    const withAgent = new Map(members).set('agt_1', 'SupportBot');
    expect(mentionLabel('agt_1', withAgent)).toBe('SupportBot');
    expect(mentionsToPlainText('<@agt_1> can you help?', withAgent)).toBe('@SupportBot can you help?');
  });
});

describe('isAgentId', () => {
  it('recognizes WeldAgent ids and nothing else', () => {
    expect(isAgentId('agt_123')).toBe(true);
    expect(isAgentId('user_1')).toBe(false);
    expect(isAgentId('')).toBe(false);
  });
});

describe('inline file tokens', () => {
  const members = new Map([['user_1', 'Rananjay']]);

  it('reads the attachment id of a file token and nothing else', () => {
    expect(fileTokenId('file:att_1')).toBe('att_1');
    expect(fileTokenId('file:')).toBeNull();
    expect(fileTokenId('user_1')).toBeNull();
    expect(fileTokenId('user_2:Ganesh')).toBeNull();
    expect(fileTokenId('ticket:tkt_1|Broken')).toBeNull();
  });

  it('lists the inline attachment ids in order, once each', () => {
    expect(fileTokenIds('a <@file:att_2> b <@user_1> <@file:att_1> <@file:att_2>')).toEqual([
      'att_2',
      'att_1',
    ]);
    expect(fileTokenIds('no files <@user_1>')).toEqual([]);
  });

  it('drops file tokens from one-line previews instead of showing an @att badge', () => {
    expect(mentionsToPlainText('look <@file:att_1> here <@user_1>', members)).toBe('look  here @Rananjay');
    expect(stripFileTokens('see <@file:att_1><@user_1>')).toBe('see <@user_1>');
  });

  it('splits the body at inline files it has, dropping the line breaks around them', () => {
    expect(splitInlineFiles('before\n<@file:att_1>\nafter <@user_1>', new Set(['att_1']))).toEqual([
      { kind: 'text', text: 'before' },
      { kind: 'file', attachmentId: 'att_1' },
      { kind: 'text', text: 'after <@user_1>' },
    ]);
    expect(splitInlineFiles('<@file:att_1><@file:att_2>', new Set(['att_1', 'att_2']))).toEqual([
      { kind: 'file', attachmentId: 'att_1' },
      { kind: 'file', attachmentId: 'att_2' },
    ]);
  });

  it('renders nothing for a token whose attachment is missing', () => {
    expect(splitInlineFiles('one <@file:gone> two', new Set())).toEqual([{ kind: 'text', text: 'one  two' }]);
    expect(splitInlineFiles('<@file:gone>', new Set())).toEqual([]);
  });

  it('keeps a plain message as one text block', () => {
    expect(splitInlineFiles('hi <@user_1>\nthere', new Set(['att_1']))).toEqual([
      { kind: 'text', text: 'hi <@user_1>\nthere' },
    ]);
  });
});
