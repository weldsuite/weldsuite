import { describe, expect, it } from 'vitest';
import { parseRecipients } from './recipients';

describe('parseRecipients', () => {
  it('splits on commas, semicolons and whitespace and drops duplicates', () => {
    expect(parseRecipients('a@x.com, B@y.com; a@x.com\nc@z.org')).toEqual({
      valid: ['a@x.com', 'b@y.com', 'c@z.org'],
      invalid: [],
    });
  });

  it('reports what is not an address', () => {
    expect(parseRecipients('a@x.com nope, b@')).toEqual({ valid: ['a@x.com'], invalid: ['nope', 'b@'] });
  });

  it('is empty for blank input', () => {
    expect(parseRecipients('  ,, ')).toEqual({ valid: [], invalid: [] });
  });
});
