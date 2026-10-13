import { describe, expect, it } from 'vitest';
import { BUILTIN_CORPUS } from './builtin';
import { fillPlaceholders, renderCorpusMessage } from './render';
import type { CorpusThread } from './types';

const mia = { firstName: 'Mia', lastName: 'Jansen' };
const tom = { firstName: 'Tom', lastName: 'Bakker' };

const thread: CorpusThread = {
  id: 'builtin-test',
  subject: 'Moving our meeting',
  messages: [
    {
      author: 'starter',
      body: 'Hi {{recipientFirstName}},\n\nCan we move our meeting?\n\nThanks,\n{{senderFirstName}} {{senderLastName}}',
    },
    { author: 'responder', body: 'Hi {{recipientFirstName}}, Friday works.\n\n{{senderFirstName}}' },
    { author: 'starter', body: 'Great. Talk soon, {{recipientFirstName}} {{recipientLastName}}.' },
  ],
};

describe('renderCorpusMessage', () => {
  it('step 0 keeps the subject and writes as the sender to the recipient', () => {
    expect(renderCorpusMessage(thread, 0, mia, tom)).toEqual({
      subject: 'Moving our meeting',
      text: 'Hi Tom,\n\nCan we move our meeting?\n\nThanks,\nMia Jansen',
    });
  });

  it('replies get "Re: " and the names follow the person writing that step', () => {
    // Step 1 is written by the responder (Tom) to the starter (Mia).
    expect(renderCorpusMessage(thread, 1, tom, mia)).toEqual({
      subject: 'Re: Moving our meeting',
      text: 'Hi Mia, Friday works.\n\nTom',
    });
    expect(renderCorpusMessage(thread, 2, mia, tom).text).toBe('Great. Talk soon, Tom Bakker.');
  });

  it('never doubles the "Re: " prefix', () => {
    const odd: CorpusThread = { ...thread, subject: 'Re: Moving our meeting' };
    expect(renderCorpusMessage(odd, 1, tom, mia).subject).toBe('Re: Moving our meeting');
    expect(renderCorpusMessage(odd, 0, mia, tom).subject).toBe('Moving our meeting');
  });

  it('throws a clear error for a step out of range', () => {
    expect(() => renderCorpusMessage(thread, 3, mia, tom)).toThrow(/step 3 is out of range for thread "builtin-test"/);
    expect(() => renderCorpusMessage(thread, -1, mia, tom)).toThrow(/out of range/);
    expect(() => renderCorpusMessage(thread, 1.5, mia, tom)).toThrow(/out of range/);
    expect(() => renderCorpusMessage(thread, Number.NaN, mia, tom)).toThrow(/out of range/);
  });

  it('tidies a greeting when a name is blank', () => {
    const blank = { firstName: '', lastName: '' };
    expect(renderCorpusMessage(thread, 1, tom, blank).text).toBe('Hi, Friday works.\n\nTom');
  });

  it('renders every built-in thread at every step with no placeholder left', () => {
    for (const item of BUILTIN_CORPUS) {
      item.messages.forEach((_message, step) => {
        const rendered = renderCorpusMessage(item, step, mia, tom);
        expect(rendered.text).not.toContain('{{');
        expect(rendered.text.length).toBeGreaterThan(0);
        expect(rendered.subject).toBe(step === 0 ? item.subject : `Re: ${item.subject}`);
      });
    }
  });
});

describe('fillPlaceholders', () => {
  const values = { a: 'Alpha', b: 'Beta', empty: '' };

  it('replaces known placeholders, also repeated ones and with inner spaces', () => {
    expect(fillPlaceholders('{{a}} and {{ b }} and {{a}}', values)).toBe('Alpha and Beta and Alpha');
  });

  it('renders unknown placeholders as nothing and tidies the spacing', () => {
    expect(fillPlaceholders('Hello {{unknown}}, welcome', values)).toBe('Hello, welcome');
    expect(fillPlaceholders('Hello {{unknown}} there', values)).toBe('Hello there');
    expect(fillPlaceholders('Hi {{empty}}!', values)).toBe('Hi!');
  });

  it('drops the line when a placeholder was the whole line', () => {
    expect(fillPlaceholders('Thanks,\n{{unknown}}', values)).toBe('Thanks,');
  });

  it('does not look up inherited properties', () => {
    expect(fillPlaceholders('{{constructor}}|{{toString}}|{{__proto__}}', values)).toBe('||');
  });

  it('leaves no {{ behind for an unterminated or nested opener', () => {
    for (const template of ['a {{ b', '{{{{{ a', 'x {{ y {{ z', '{{a}} {{ {{b}}', '{{{a}}}', 'plain }} text']) {
      expect(fillPlaceholders(template, values)).not.toContain('{{');
    }
    expect(fillPlaceholders('a {{ b', values)).toBe('a b');
  });

  it('strips braces from names so a value cannot smuggle a placeholder in', () => {
    expect(fillPlaceholders('Hi {{a}}', { a: '{{b}}' })).toBe('Hi b');
  });

  it('is linear: a huge template of openers finishes at once', () => {
    const started = Date.now();
    const result = fillPlaceholders('{{'.repeat(200_000), values);
    expect(result).not.toContain('{{');
    expect(Date.now() - started).toBeLessThan(2000);

    const closed = fillPlaceholders(`${'{{'.repeat(100_000)}}}`, values);
    expect(closed).not.toContain('{{');
  });
});
