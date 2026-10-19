import { describe, expect, it } from 'vitest';
import {
  bareMessageId,
  bareSubject,
  conversationSubjects,
  hasReplyPrefix,
  involvesAddress,
  messageIdVariants,
  providerMessageIds,
} from './thread-match';

describe('message ids', () => {
  it('strips and re-adds the angle brackets so both spellings match', () => {
    expect(bareMessageId(' <abc@weldmail.example> ')).toBe('abc@weldmail.example');
    expect(messageIdVariants(['<abc@x.test>', 'def@y.test', '<abc@x.test>', ''])).toEqual([
      'abc@x.test',
      '<abc@x.test>',
      'def@y.test',
      '<def@y.test>',
    ]);
  });

  it('takes the local part for providers that rewrite the host', () => {
    expect(providerMessageIds(['<abc-123@eu-west-1.amazonses.com>', 'abc-123@other.test', 'plain'])).toEqual([
      'abc-123',
      'plain',
    ]);
  });
});

describe('subjects', () => {
  it('strips repeated reply and forward prefixes in any casing', () => {
    expect(bareSubject('Re: RE: Fwd: Quarterly numbers')).toBe('Quarterly numbers');
    expect(bareSubject('AW: Re[2]: Hello')).toBe('Hello');
    expect(bareSubject('Fw:Hello')).toBe('Hello');
    expect(bareSubject('Revenue: Q3')).toBe('Revenue: Q3');
    expect(bareSubject(undefined)).toBe('');
  });

  it('recognises a reply prefix', () => {
    expect(hasReplyPrefix('Re: Support request')).toBe(true);
    expect(hasReplyPrefix('FWD: Support request')).toBe(true);
    expect(hasReplyPrefix('Support request')).toBe(false);
    expect(hasReplyPrefix('Reminder: invoice')).toBe(false);
  });

  it('lists the subjects an earlier message of the conversation can carry', () => {
    expect(conversationSubjects('Re: Support Request')).toEqual(['support request', 're: support request']);
    expect(conversationSubjects('Re:')).toEqual([]);
  });
});

describe('involvesAddress', () => {
  const stored = {
    from: { email: 'Me@Weldmail.example', name: 'Me' },
    to: [{ email: 'support@helpdesk.example' }],
    cc: null,
  };

  it('matches the sender or a recipient, ignoring case', () => {
    expect(involvesAddress(stored, 'support@HELPDESK.example')).toBe(true);
    expect(involvesAddress(stored, 'me@weldmail.example')).toBe(true);
  });

  it('does not match a stranger or an empty address', () => {
    expect(involvesAddress(stored, 'stranger@elsewhere.example')).toBe(false);
    expect(involvesAddress(stored, undefined)).toBe(false);
  });
});
