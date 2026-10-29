/**
 * Escaping and shaping for the two FTS5 MATCH query builders (design
 * Decisions #3, §3.3): the trigram meta table (substring) and the unicode61
 * body table (token-prefix, `detail=column`, so never a phrase).
 */
import { describe, expect, it } from 'vitest';
import {
  buildBodyMatchQuery,
  buildExcludeWordsMatchQuery,
  buildMailSearchQuery,
  buildMetaMatchQuery,
  quoteFtsPhrase,
} from './fts-query';

describe('quoteFtsPhrase', () => {
  it('wraps the value in double quotes', () => {
    expect(quoteFtsPhrase('invoice')).toBe('"invoice"');
  });

  it('doubles an internal double quote', () => {
    expect(quoteFtsPhrase('she said "hi"')).toBe('"she said ""hi"""');
  });
});

describe('buildMetaMatchQuery', () => {
  it('quotes the trimmed query as one phrase', () => {
    expect(buildMetaMatchQuery('  invoice  ')).toBe('"invoice"');
  });

  it('never lets FTS operators or column filters through unescaped', () => {
    expect(buildMetaMatchQuery('subject: AND OR NOT "x" (y)')).toBe('"subject: AND OR NOT ""x"" (y)"');
  });

  it('is null for empty or blank input', () => {
    expect(buildMetaMatchQuery('')).toBeNull();
    expect(buildMetaMatchQuery('   ')).toBeNull();
    expect(buildMetaMatchQuery(null)).toBeNull();
    expect(buildMetaMatchQuery(undefined)).toBeNull();
  });
});

describe('buildBodyMatchQuery', () => {
  it('lower-cases and prefix-matches each word, ANDed', () => {
    expect(buildBodyMatchQuery('Invoice Payment')).toBe('invoice* AND payment*');
  });

  it('neutralises AND/OR/NOT typed by the user into ordinary lower-case tokens', () => {
    // Upper-case AND/OR/NOT would be read as FTS5 operators; lower-casing defuses them.
    expect(buildBodyMatchQuery('cats AND dogs OR NOT fish')).toBe('cats* AND and* AND dogs* AND or* AND not* AND fish*');
  });

  it('strips punctuation and FTS syntax characters entirely rather than passing them through', () => {
    expect(buildBodyMatchQuery('foo* OR (bar) - "baz"')).toBe('foo* AND or* AND bar* AND baz*');
  });

  it('is null when there are no word characters at all', () => {
    expect(buildBodyMatchQuery('!!! ---')).toBeNull();
    expect(buildBodyMatchQuery('')).toBeNull();
    expect(buildBodyMatchQuery(null)).toBeNull();
  });

  it('keeps digits as part of the token stream', () => {
    expect(buildBodyMatchQuery('invoice 2024')).toBe('invoice* AND 2024*');
  });
});

describe('buildMailSearchQuery', () => {
  it('builds both the meta and body arguments for a normal search', () => {
    expect(buildMailSearchQuery('Invoice 2024')).toEqual({
      meta: '"Invoice 2024"',
      body: 'invoice* AND 2024*',
    });
  });

  it('is null for an empty/blank search', () => {
    expect(buildMailSearchQuery('')).toBeNull();
    expect(buildMailSearchQuery('   ')).toBeNull();
    expect(buildMailSearchQuery(null)).toBeNull();
  });

  it('degrades to a meta-only query when the input has no word characters', () => {
    expect(buildMailSearchQuery('@@@')).toEqual({ meta: '"@@@"', body: null });
  });
});

describe('buildExcludeWordsMatchQuery', () => {
  it('prefix-matches every word, ORed', () => {
    expect(buildExcludeWordsMatchQuery('unsubscribe newsletter')).toBe('unsubscribe* OR newsletter*');
  });

  it('is null for no words', () => {
    expect(buildExcludeWordsMatchQuery('')).toBeNull();
    expect(buildExcludeWordsMatchQuery(undefined)).toBeNull();
  });
});
