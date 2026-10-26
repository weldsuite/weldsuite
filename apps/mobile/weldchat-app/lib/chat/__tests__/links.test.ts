import { findLinks } from '../links';

describe('findLinks', () => {
  it('finds http(s) and www. addresses, leaving trailing punctuation out', () => {
    const links = findLinks('See https://example.com/a?b=1, and www.weldsuite.org.');
    expect(links.map((l) => l.text)).toEqual(['https://example.com/a?b=1', 'www.weldsuite.org']);
    expect(links.map((l) => l.href)).toEqual(['https://example.com/a?b=1', 'https://www.weldsuite.org']);
  });

  it('reports where each link sits in the text', () => {
    const text = 'go to (https://weldsuite.org) now';
    const [link] = findLinks(text);
    expect(text.slice(link.start, link.end)).toBe('https://weldsuite.org');
  });

  it('ignores text without a web address', () => {
    expect(findLinks('mail me at bob@example.com or call 0612345678')).toEqual([]);
    expect(findLinks('')).toEqual([]);
  });
});
