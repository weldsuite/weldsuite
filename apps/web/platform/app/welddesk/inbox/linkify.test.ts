import { describe, expect, it } from 'vitest';
import { linkifyText } from '@weldsuite/app-api-client/schemas/desk-linkify';

const links = (text: string) =>
  linkifyText(text)
    .filter((part) => part.type === 'link')
    .map((part) => (part.type === 'link' ? part.href : ''));

describe('linkifyText', () => {
  it('turns http(s) and www URLs into links and keeps the text around them', () => {
    expect(linkifyText('See https://acme.test/a for more')).toEqual([
      { type: 'text', text: 'See ' },
      { type: 'link', text: 'https://acme.test/a', href: 'https://acme.test/a' },
      { type: 'text', text: ' for more' },
    ]);
    expect(links('go to www.acme.test/help')).toEqual(['https://www.acme.test/help']);
  });

  it('leaves sentence punctuation and an unopened closing bracket out of the link', () => {
    expect(links('Read https://acme.test/faq.')).toEqual(['https://acme.test/faq']);
    expect(links('(see https://acme.test/x)!')).toEqual(['https://acme.test/x']);
    expect(links('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
  });

  it('stays fast on a hostile message', () => {
    const hostile = `https://a.test/${')'.repeat(50_000)}${'!'.repeat(50_000)}x`;
    const started = Date.now();
    const parts = linkifyText(hostile);
    expect(Date.now() - started).toBeLessThan(500);
    expect(parts.map((p) => p.text).join('')).toBe(hostile);
  });
});
