import { describe, expect, it } from 'vitest';
import {
  deskArticleDraftFrom,
  deskArticleSlug,
  deskArticleUrl,
  deskRelatedSearch,
  deskSearchWords,
  deskSuggestSearch,
  deskTypedSearch,
  normalizeDeskLocale,
} from './desk-articles';

describe('desk article search terms', () => {
  it('splits words on anything but letters and digits, in any script', () => {
    expect(deskSearchWords("Can't log-in? Café №5 日本語")).toEqual(['can', 't', 'log', 'in', 'café', '5', '日本語']);
  });

  it('types a query as websearch text OR its words with the last one a prefix', () => {
    expect(deskTypedSearch('  Reset pass ')).toEqual({ websearch: 'Reset pass', tsquery: "'reset' & 'pass':*" });
    expect(deskTypedSearch('"reset your" -password')).toEqual({
      websearch: '"reset your" -password',
      tsquery: "'reset' & 'your' & 'password':*",
    });
    expect(deskTypedSearch('a b c d e f g h i j')?.tsquery).toBe("'a' & 'b' & 'c' & 'd' & 'e' & 'f' & 'g' & 'h':*");
    expect(deskTypedSearch('')).toBeNull();
    expect(deskTypedSearch(' ?! ')).toBeNull();
  });

  it('relates text through its distinct words of four characters or more, at most twelve', () => {
    expect(deskRelatedSearch('How do I reset my PASSWORD? Reset it please')).toEqual({
      websearch: null,
      tsquery: "'reset' | 'password' | 'please'",
    });
    const many = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    expect(deskRelatedSearch(many)?.tsquery?.split(' | ')).toHaveLength(12);
    expect(deskRelatedSearch('hi to me')).toBeNull();
  });

  it('suggests on the longer words of a question, any of them, with the word being typed as a prefix', () => {
    expect(deskSuggestSearch('How do I reset my password')).toEqual({
      websearch: null,
      tsquery: "'reset' | 'password':*",
    });
    // The text ends after the word (a question mark, a full stop): no prefix.
    expect(deskSuggestSearch('How do I reset my password? ')?.tsquery).toBe("'reset' | 'password'");
    // The word being typed is short or a repeat: the longer words as they are.
    expect(deskSuggestSearch('reset password for my vpn')?.tsquery).toBe("'reset' | 'password'");
    expect(deskSuggestSearch('password reset password')?.tsquery).toBe("'password' | 'reset'");
    const many = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    expect(deskSuggestSearch(many)?.tsquery?.split(' | ')).toHaveLength(12);
    expect(deskSuggestSearch(many)?.tsquery).not.toContain(':*');
  });

  it('suggests as typed when every word is short', () => {
    expect(deskSuggestSearch('vpn 2fa')).toEqual({ websearch: 'vpn 2fa', tsquery: "'vpn' & '2fa':*" });
    expect(deskSuggestSearch(' ?! ')).toBeNull();
  });
});

describe('desk article helpers', () => {
  it('slugs a title', () => {
    expect(deskArticleSlug('  Hello, World! Ça va?  ')).toBe('hello-world-a-va');
    expect(deskArticleSlug('???')).toBe('');
  });

  it('normalises a locale', () => {
    expect(normalizeDeskLocale(' PT-BR ')).toBe('pt-br');
    expect(normalizeDeskLocale('')).toBeNull();
    expect(normalizeDeskLocale(null)).toBeNull();
  });

  it('links an article on the help center when there is one', () => {
    expect(deskArticleUrl('https://help.acme.test', 'reset')).toBe('https://help.acme.test/articles/reset');
    expect(deskArticleUrl(null, 'reset')).toBeNull();
  });
});

describe('deskArticleDraftFrom', () => {
  const message = (authorType: string, body: string | null, kind = 'message') => ({ kind, authorType, body }) as never;

  it('quotes the customer, then the team’s public replies, escaped', () => {
    const draft = deskArticleDraftFrom({ title: null, conversationNumber: 7 }, [
      message('visitor', ' First line\r\nsecond <line> '),
      message('agent', 'internal', 'note'),
      message('agent', 'Use "this" & that'),
      message('bot', 'a bot'),
      message('visitor', '   '),
      message('system', null, 'event'),
    ]);
    expect(draft).toEqual({
      title: 'First line',
      content: '<blockquote><p>First line<br>second &lt;line&gt;</p></blockquote><p>Use &quot;this&quot; &amp; that</p>',
      excerpt: 'First line second <line>',
    });
  });

  it('prefers the conversation title, and falls back to its number', () => {
    expect(deskArticleDraftFrom({ title: ' Billing ', conversationNumber: 1 }, []).title).toBe('Billing');
    expect(deskArticleDraftFrom({ title: null, conversationNumber: 42 }, [])).toEqual({ title: '#42', content: '<p></p>', excerpt: null });
    expect(Array.from(deskArticleDraftFrom({ title: 'é'.repeat(300), conversationNumber: 1 }, []).title)).toHaveLength(200);
  });
});
