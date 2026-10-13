import { describe, expect, it } from 'vitest';
import type { CorpusThread } from './types';
import { findContentIssue, parseCorpusThread, parseCorpusThreads } from './validate';

function thread(overrides: Partial<CorpusThread> = {}): CorpusThread {
  return {
    id: 'gen-2026-10-001',
    subject: 'Moving our meeting',
    messages: [
      { author: 'starter', body: 'Hi {{recipientFirstName}}, can we move our meeting to Friday morning?\n\nThanks,\n{{senderFirstName}}' },
      { author: 'responder', body: 'Friday morning works for me, see you then.\n\n{{senderFirstName}}' },
    ],
    ...overrides,
  };
}

describe('findContentIssue', () => {
  it.each([
    ['a link', 'Have a look at http://example.invalid/page when you can.'],
    ['a www address', 'Details are on www.example.invalid for now.'],
    ['an email address', 'Write to me at someone@example.invalid please.'],
    ['a bare domain', 'The details are on example.com if you want them.'],
    ['a phone number', 'You can reach me on +31 6 1234 5678 after lunch.'],
    ['a currency symbol', 'The quote came to $4,200 in the end.'],
    ['a euro symbol', 'The quote came to €4,200 in the end.'],
    ['a spam word', 'This is a free upgrade for you.'],
    ['a warmup word', 'This is only a warmup message.'],
    ['a test word', 'Just a quick test before we go live.'],
    ['a spam phrase', 'Act now before the date passes.'],
    ['an attachment mention', 'See the attached document for details.'],
    ['markdown', 'This is **really** important to me.'],
    ['an emoji', 'Thanks a lot \u{1F600} see you soon.'],
    ['an unknown placeholder', 'Hi {{customerName}}, thanks for your time.'],
    ['an unterminated placeholder', 'Hi {{recipientFirstName, thanks for your time.'],
  ])('rejects %s', (_label, text) => {
    expect(findContentIssue(text)).not.toBeNull();
  });

  it.each([
    'Thursday morning works. How about 10:00? I will send an invite.',
    'The order was placed under reference 4471 and totals 2,300 for the quarter.',
    'We moved from 12 to 15 people, so the quote changes a little.',
    'Please see the latest version, and the contest rules are fine.',
    'Hi {{recipientFirstName}}, thanks.\n\nBest,\n{{senderFirstName}} {{senderLastName}}',
    'Meet at 2 p.m. at the entrance, e.g. by the front desk.',
  ])('accepts %j', (text) => {
    expect(findContentIssue(text)).toBeNull();
  });

  it('does not treat words that merely contain a forbidden word as forbidden', () => {
    expect(findContentIssue('The latest contest results and a freelance designer are fine.')).toBeNull();
  });
});

describe('parseCorpusThread', () => {
  it('accepts a well-formed thread', () => {
    expect(parseCorpusThread(thread())).toMatchObject({ id: 'gen-2026-10-001', subject: 'Moving our meeting' });
  });

  it('trims subject and bodies', () => {
    const parsed = parseCorpusThread(thread({ subject: '  Moving our meeting  ' }));
    expect(parsed?.subject).toBe('Moving our meeting');
  });

  it('rejects fewer than 2 or more than 4 messages', () => {
    const [first, second] = thread().messages;
    expect(parseCorpusThread(thread({ messages: first ? [first] : [] }))).toBeNull();
    const five = [first, second, first, second, first].flatMap((message) => (message ? [message] : []));
    expect(parseCorpusThread(thread({ messages: five }))).toBeNull();
  });

  it('rejects a thread that does not alternate starting with the starter', () => {
    const [first, second] = thread().messages;
    if (!first || !second) throw new Error('fixture');
    expect(parseCorpusThread(thread({ messages: [second, first] }))).toBeNull();
    expect(parseCorpusThread(thread({ messages: [first, { ...second, author: 'starter' }] }))).toBeNull();
  });

  it('rejects empty or too long subjects and bodies', () => {
    const [first, second] = thread().messages;
    if (!first || !second) throw new Error('fixture');
    expect(parseCorpusThread(thread({ subject: '   ' }))).toBeNull();
    expect(parseCorpusThread(thread({ subject: 'x'.repeat(200) }))).toBeNull();
    expect(parseCorpusThread(thread({ messages: [first, { ...second, body: '   ' }] }))).toBeNull();
    expect(parseCorpusThread(thread({ messages: [first, { ...second, body: 'word '.repeat(400) }] }))).toBeNull();
  });

  it('rejects a "Re:" subject', () => {
    expect(parseCorpusThread(thread({ subject: 'Re: Moving our meeting' }))).toBeNull();
  });

  it('rejects links, addresses and spam words in a body or the subject', () => {
    const [first, second] = thread().messages;
    if (!first || !second) throw new Error('fixture');
    expect(parseCorpusThread(thread({ messages: [{ ...first, body: 'Hi {{recipientFirstName}}, see http://example.invalid today.' }, second] }))).toBeNull();
    expect(parseCorpusThread(thread({ messages: [first, { ...second, body: 'Mail me on someone@example.invalid thanks.' }] }))).toBeNull();
    expect(parseCorpusThread(thread({ subject: 'Free tickets for you' }))).toBeNull();
  });

  it('rejects a greeting or signature that uses a real name instead of a placeholder', () => {
    const [first, second] = thread().messages;
    if (!first || !second) throw new Error('fixture');
    const greeted = { ...first, body: 'Hi Sarah, can we move our meeting to Friday?\n\nThanks,\n{{senderFirstName}}' };
    const signed = { ...second, body: 'Friday works for me, see you then.\n\nBest,\nDaniel' };
    expect(parseCorpusThread(thread({ messages: [greeted, second] }))).toBeNull();
    expect(parseCorpusThread(thread({ messages: [first, signed] }))).toBeNull();
    const group = { ...first, body: 'Hi all, can we move our meeting to Friday morning?\n\nThanks,\n{{senderFirstName}}' };
    expect(parseCorpusThread(thread({ messages: [group, second] }))).not.toBeNull();
  });

  it('rejects things that are not threads', () => {
    expect(parseCorpusThread(null)).toBeNull();
    expect(parseCorpusThread('thread')).toBeNull();
    expect(parseCorpusThread({ id: 'x', subject: 'Hello there', messages: 'no' })).toBeNull();
  });
});

describe('parseCorpusThreads', () => {
  it('keeps valid threads in order and drops invalid ones and repeated ids', () => {
    const a = thread({ id: 'a' });
    const b = thread({ id: 'b', subject: 'Re: broken' });
    const c = thread({ id: 'c' });
    const duplicate = thread({ id: 'a', subject: 'Another subject' });
    expect(parseCorpusThreads([a, b, c, duplicate, 42]).map((item) => item.id)).toEqual(['a', 'c']);
  });

  it('returns nothing for a value that is not an array', () => {
    expect(parseCorpusThreads({ threads: [thread()] })).toEqual([]);
    expect(parseCorpusThreads(null)).toEqual([]);
  });
});
