import { describe, expect, it } from 'vitest';
import { normalizeDomain, parseDomains } from './embed-domains';
import { isoToLocalInput, localInputToIso } from './datetime';

describe('embed domains', () => {
  it('reduces urls to hostnames', () => {
    expect(normalizeDomain('https://www.Example.com/page?x=1')).toBe('www.example.com');
    expect(normalizeDomain('example.com:8080')).toBe('example.com');
    expect(normalizeDomain('*.example.org')).toBe('example.org');
    expect(normalizeDomain('localhost')).toBe('localhost');
  });

  it('rejects what is not a hostname', () => {
    expect(normalizeDomain('')).toBeNull();
    expect(normalizeDomain('not a domain')).toBeNull();
    expect(normalizeDomain('exa_mple.com')).toBeNull();
    expect(normalizeDomain('com')).toBeNull();
  });

  it('parses lists, dedupes and reports the invalid ones', () => {
    expect(parseDomains('a.com, b.com\nhttps://a.com/x;nope!')).toEqual({ domains: ['a.com', 'b.com'], invalid: ['nope!'] });
    expect(parseDomains('  \n ')).toEqual({ domains: [], invalid: [] });
  });
});

describe('datetime-local conversion', () => {
  it('round-trips a local time', () => {
    const iso = localInputToIso('2026-11-09T14:30');
    expect(iso).toMatch(/^2026-11-09T14:30:00[+-]\d{2}:\d{2}$/);
    expect(isoToLocalInput(iso)).toBe('2026-11-09T14:30');
  });

  it('handles empty and invalid values', () => {
    expect(localInputToIso('')).toBeNull();
    expect(localInputToIso('garbage')).toBeNull();
    expect(isoToLocalInput(null)).toBe('');
    expect(isoToLocalInput('nonsense')).toBe('');
  });
});
