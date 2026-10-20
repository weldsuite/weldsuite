import { describe, expect, it } from 'vitest';
import { secretMatches, timingSafeEqualStr } from './timing-safe';

describe('timingSafeEqualStr', () => {
  it('is true for identical strings', () => {
    expect(timingSafeEqualStr('s3cret-value', 's3cret-value')).toBe(true);
    expect(timingSafeEqualStr('', '')).toBe(true);
  });

  it('is false when a single character differs', () => {
    expect(timingSafeEqualStr('s3cret-value', 's3cret-valuf')).toBe(false);
    expect(timingSafeEqualStr('s3cret-value', 'x3cret-value')).toBe(false);
  });

  it('is false when one string is a prefix of the other, in either direction', () => {
    expect(timingSafeEqualStr('secret', 'secret-and-more')).toBe(false);
    expect(timingSafeEqualStr('secret-and-more', 'secret')).toBe(false);
  });

  it('is false against an empty string', () => {
    expect(timingSafeEqualStr('', 'secret')).toBe(false);
    expect(timingSafeEqualStr('secret', '')).toBe(false);
  });

  it('compares multi-byte characters by their UTF-8 bytes', () => {
    expect(timingSafeEqualStr('gëheim', 'gëheim')).toBe(true);
    expect(timingSafeEqualStr('gëheim', 'geheim')).toBe(false);
  });
});

describe('secretMatches', () => {
  it('is true only when both are set and equal', () => {
    expect(secretMatches('abc', 'abc')).toBe(true);
    expect(secretMatches('abd', 'abc')).toBe(false);
  });

  it('never authorizes when the expected secret is unset or empty', () => {
    expect(secretMatches('abc', undefined)).toBe(false);
    expect(secretMatches('abc', null)).toBe(false);
    expect(secretMatches('abc', '')).toBe(false);
    expect(secretMatches('', '')).toBe(false);
    expect(secretMatches(undefined, undefined)).toBe(false);
  });

  it('never authorizes when nothing was provided', () => {
    expect(secretMatches(undefined, 'abc')).toBe(false);
    expect(secretMatches(null, 'abc')).toBe(false);
    expect(secretMatches('', 'abc')).toBe(false);
  });
});
