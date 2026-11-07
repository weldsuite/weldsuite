import { describe, expect, it } from 'vitest';
import { cycleState, fill, formatDateRange, initials, providerChatMarkdown, providerMarkdown, providerPreviewText, relativeTime } from './format';

describe('fill', () => {
  it('replaces placeholders and leaves unknown ones', () => {
    expect(fill('{a} of {b} and {c}', { a: 1, b: 'x' })).toBe('1 of x and {c}');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-11-05T12:00:00.000Z');

  it('says just now under a minute and for the future', () => {
    expect(relativeTime('2026-11-05T11:59:30.000Z', 'en', 'just now', now)).toBe('just now');
    expect(relativeTime('2026-11-05T12:05:00.000Z', 'en', 'just now', now)).toBe('just now');
  });

  it('uses the largest unit that fits', () => {
    expect(relativeTime('2026-11-05T11:00:00.000Z', 'en', 'just now', now)).toContain('1');
    expect(relativeTime('2026-11-03T12:00:00.000Z', 'en', 'just now', now)).toContain('2');
  });

  it('returns an empty string for an invalid date', () => {
    expect(relativeTime('nope', 'en', 'just now', now)).toBe('');
  });
});

describe('cycleState', () => {
  it('compares a cycle with today', () => {
    expect(cycleState('2026-11-10', '2026-11-20', '2026-11-05')).toBe('upcoming');
    expect(cycleState('2026-11-01', '2026-11-20', '2026-11-05')).toBe('current');
    expect(cycleState('2026-10-01', '2026-10-14', '2026-11-05')).toBe('past');
    expect(cycleState('2026-11-05', '2026-11-05', '2026-11-05')).toBe('current');
  });
});

describe('formatDateRange and initials', () => {
  it('formats both ends in the given locale', () => {
    expect(formatDateRange('2026-11-03', '2026-11-16', 'en')).toBe('Nov 3 – Nov 16');
  });

  it('takes the first and last initial', () => {
    expect(initials('Sanne de Vries')).toBe('SV');
    expect(initials('octocat')).toBe('O');
    expect(initials('  ')).toBe('?');
  });
});

describe('providerMarkdown', () => {
  it('drops HTML comments, as the provider never shows them', () => {
    expect(providerMarkdown('<!-- bot:state {"a":1} -->\nLooks good\n<!-- end -->')).toBe('Looks good');
    expect(providerMarkdown('Text <!-- unclosed')).toBe('Text');
    expect(providerMarkdown('No comments here')).toBe('No comments here');
  });

  it('drops HTML tags outside code and keeps the text inside them', () => {
    expect(providerMarkdown('<details><summary>Preview</summary>Ready <img src="x.png" /></details>')).toBe('Preview\nReady');
    expect(providerMarkdown('Use `<Button>` here\n```tsx\n<Panel />\n```')).toBe('Use `<Button>` here\n```tsx\n<Panel />\n```');
    expect(providerMarkdown('a < b and c > d')).toBe('a < b and c > d');
  });

  it("writes GitHub's alert marker as its title", () => {
    expect(providerMarkdown('> [!TIP]\n> Approved')).toBe('> **Tip**\n> Approved');
    expect(providerMarkdown('[!warning]\nCareful')).toBe('**Warning**\nCareful');
  });
});

describe('providerPreviewText', () => {
  it('reads a Markdown comment as one plain line', () => {
    expect(providerPreviewText('<!-- s -->**🟡 Minor**: only `user` [ops](https://x.test) count\n\n- one\n> quoted')).toBe(
      '🟡 Minor: only user ops count one quoted',
    );
  });

  it('keeps the words of images and of links with a title', () => {
    expect(providerPreviewText('![chart](https://x.test/c.png) and [link](https://x.test "Title")')).toBe('chart and link');
  });
});

describe('providerChatMarkdown', () => {
  it('turns links into text with the URL, and drops images and link definitions', () => {
    const body = '[vc]: #abc123==\nRead [the docs](https://vercel.link/learn) ![Skipped](https://x.test/s.svg)\n`[keep](me)`';
    expect(providerChatMarkdown(body)).toBe('Read the docs (https://vercel.link/learn) \n`[keep](me)`');
    expect(providerChatMarkdown('[![badge](https://x.test/b.svg)](https://x.test/run)')).toBe('https://x.test/run');
  });

  it('leaves out a link title', () => {
    expect(providerChatMarkdown('See [the docs](https://x.test/d "The docs").')).toBe('See the docs (https://x.test/d).');
  });
});
