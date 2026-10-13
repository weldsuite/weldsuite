import { describe, expect, it } from 'vitest';
import { parseSuppressionInput } from './suppressions';

describe('parseSuppressionInput', () => {
  it('accepts emails and domains separated by lines, commas or spaces, lower-cased and de-duplicated', () => {
    const { values, invalid } = parseSuppressionInput('Anna@Acme.com\nacme.com, anna@acme.com ; sub.example.nl');
    expect(values).toEqual(['anna@acme.com', 'acme.com', 'sub.example.nl']);
    expect(invalid).toEqual([]);
  });

  it('reports what is neither an email nor a domain', () => {
    const { values, invalid } = parseSuppressionInput('ok@acme.com\nnot an address\nlocalhost\n@acme.com');
    expect(values).toEqual(['ok@acme.com']);
    expect(invalid).toEqual(['not', 'an', 'address', 'localhost', '@acme.com']);
  });

  it('ignores empty input', () => {
    expect(parseSuppressionInput('  \n ,; ')).toEqual({ values: [], invalid: [] });
  });
});
