import { describe, it, expect } from 'vitest';
import {
  extractVariables,
  getUniqueVariableNames,
  hasVariables,
  validateVariableName,
  createVariable,
  replaceVariables,
  getMissingVariables,
} from './template-variables';

describe('extractVariables', () => {
  it('finds variables with and without modifiers', () => {
    const result = extractVariables('Hi {{firstName}}, balance {{amount|currency}}.');
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ name: 'firstName', modifier: undefined });
    expect(result[1]).toMatchObject({ name: 'amount', modifier: 'currency' });
  });

  it('returns an empty array when content has no variables', () => {
    expect(extractVariables('plain text')).toEqual([]);
  });

  it('preserves the position of each variable', () => {
    const out = extractVariables('a {{x}} b {{y}}');
    expect(out[0]?.position).toBe(2);
    expect(out[1]?.position).toBe(10);
  });
});

describe('getUniqueVariableNames', () => {
  it('deduplicates repeated variables', () => {
    expect(getUniqueVariableNames('{{x}} {{y}} {{x}}')).toEqual(['x', 'y']);
  });
});

describe('hasVariables', () => {
  it.each([
    ['{{name}}', true],
    ['no variables here', false],
    ['{{ partial', false],
    ['{{name|modifier}}', true],
  ])('"%s" → %s', (input, expected) => {
    expect(hasVariables(input)).toBe(expected);
  });
});

describe('validateVariableName', () => {
  it('rejects empty names', () => {
    expect(validateVariableName('').isValid).toBe(false);
    expect(validateVariableName('   ').isValid).toBe(false);
  });

  it('accepts alphanumeric names', () => {
    expect(validateVariableName('firstName').isValid).toBe(true);
    expect(validateVariableName('user_id').isValid).toBe(true);
    expect(validateVariableName('A1').isValid).toBe(true);
  });
});

describe('createVariable', () => {
  it('emits the canonical {{name}} form', () => {
    expect(createVariable('firstName')).toBe('{{firstName}}');
  });

  it('emits the {{name|modifier}} form when given a valid modifier', () => {
    expect(createVariable('amount', 'currency')).toBe('{{amount|currency}}');
  });

  it('throws on an invalid name', () => {
    expect(() => createVariable('')).toThrow();
  });

  it('throws on an invalid modifier', () => {
    expect(() => createVariable('x', 'noSuchModifier_!!')).toThrow();
  });
});

describe('replaceVariables', () => {
  it('substitutes simple variables from the data object', () => {
    expect(
      replaceVariables('Hi {{firstName}} {{lastName}}', {
        firstName: 'Jane',
        lastName: 'Doe',
      }),
    ).toBe('Hi Jane Doe');
  });

  it('uses the formatter when a currency modifier is present', () => {
    expect(
      replaceVariables(
        'Total: {{amount|currency}}',
        { amount: 1000 },
        { currency: (v) => `$${v.toFixed(2)}` },
      ),
    ).toBe('Total: $1000.00');
  });

  it('replaces missing/null variables with the empty string', () => {
    expect(replaceVariables('hello {{missing}}!', {})).toBe('hello !');
  });

  it('handles repeated variables in the same template', () => {
    expect(
      replaceVariables('{{name}}, again {{name}}', { name: 'Acme' }),
    ).toBe('Acme, again Acme');
  });
});

describe('getMissingVariables', () => {
  it('returns variables that have no data field', () => {
    expect(
      getMissingVariables('{{a}} {{b}} {{c}}', { a: 1, c: 3 }),
    ).toEqual(['b']);
  });

  it('returns an empty array when every variable has data', () => {
    expect(getMissingVariables('{{a}}', { a: 1 })).toEqual([]);
  });
});
