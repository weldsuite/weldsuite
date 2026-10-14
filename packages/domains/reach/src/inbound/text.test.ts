/**
 * The reply-text helpers the inbox reads with: cutting the quoted conversation,
 * HTML to text, snippets and subjects, plus the linear-time address scan.
 * (Parsing whole `.eml` fixtures is covered in reach-api's inbound tests.)
 */

import { describe, expect, it } from 'vitest';
import { findEmails } from './strings';
import { htmlToText, makeSnippet, normalizeSubject, replySubject, stripQuotedHistory } from './text';

describe('stripQuotedHistory', () => {
  it('cuts wrapped attributions in several languages', () => {
    expect(stripQuotedHistory('Yes please.\n\nOn Mon, Oct 12, 2026 at 9:14 AM Sam Jansen <sam@getacme.com>\nwrote:\n> hi')).toBe('Yes please.');
    expect(stripQuotedHistory('Graag.\n\nOp ma 12 okt. 2026 om 09:14 schreef Sam Jansen <sam@getacme.com>:\n> hoi')).toBe('Graag.');
    expect(stripQuotedHistory('Gerne.\n\nAm 12.10.2026 um 09:14 schrieb Sam Jansen <sam@getacme.com>:\n> hallo')).toBe('Gerne.');
    expect(stripQuotedHistory('Oui.\n\nLe lun. 12 oct. 2026 à 09:14, Sam <sam@getacme.com> a écrit :\n> salut')).toBe('Oui.');
    expect(stripQuotedHistory('Sure\n\n-----Original Message-----\nFrom: Sam\nSent: Monday\nTo: Jane\nSubject: Hi\n\nquoted')).toBe('Sure');
  });

  it('cuts the Outlook header block and drops > lines and mobile footers', () => {
    expect(stripQuotedHistory('Thanks\n\nFrom: Sam\nSent: Monday\nTo: Jane\nSubject: Hi\n\nquoted')).toBe('Thanks');
    expect(stripQuotedHistory('Line one\n> quoted\nLine two')).toBe('Line one\nLine two');
    expect(stripQuotedHistory('Sounds good\n\nSent from my iPhone')).toBe('Sounds good');
  });

  it('keeps ordinary sentences that start with "On"', () => {
    const text = 'On Monday we can meet.\nOr on Tuesday.\nJane';
    expect(stripQuotedHistory(text)).toBe(text);
  });
});

describe('htmlToText', () => {
  it('turns HTML into text without the quote', () => {
    const html = '<div dir="ltr">Hi Sam,<br><br>Fine &amp; dandy</div><div class="gmail_quote"><blockquote>old</blockquote></div>';
    expect(htmlToText(html)).toBe('Hi Sam,\n\nFine & dandy');
  });
});

describe('snippets and subjects', () => {
  it('builds a one-line snippet of at most 500 chars', () => {
    expect(makeSnippet('a\n\nb   c')).toBe('a b c');
    expect(makeSnippet('x'.repeat(900))).toHaveLength(500);
  });

  it('normalises subjects and builds the answer subject without stacking prefixes', () => {
    expect(normalizeSubject('Re: RE: Aw: Fwd: Hello')).toBe('Hello');
    expect(replySubject('RE: Hello')).toBe('Re: Hello');
    expect(replySubject('Hello')).toBe('Re: Hello');
    expect(replySubject(null)).toBe('Re:');
  });
});

describe('findEmails', () => {
  it('finds addresses without confusing neighbours', () => {
    expect(findEmails('Mail a.b@c-d.example, <x_y+z@sub.example.org>. And bad@x or @nothing.com.').map((f) => f.email)).toEqual([
      'a.b@c-d.example',
      'x_y+z@sub.example.org',
    ]);
  });

  it('stays fast on hostile input', () => {
    const started = performance.now();
    stripQuotedHistory('On x\n'.repeat(80_000));
    htmlToText('<a '.repeat(150_000));
    findEmails('a@'.repeat(150_000));
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
