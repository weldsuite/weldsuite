import { describe, expect, it } from 'vitest';
import { fillIssueTemplate, humanizeKey, parseNumberInput } from './text';

describe('fillIssueTemplate', () => {
  const template = 'The net pay is negative[ ({net})]. Check the deductions.';

  it('keeps an optional part when its param is present', () => {
    expect(fillIssueTemplate(template, { net: '-12.00' })).toBe('The net pay is negative (-12.00). Check the deductions.');
  });

  it('drops an optional part when a param inside it is missing', () => {
    expect(fillIssueTemplate(template, {})).toBe('The net pay is negative. Check the deductions.');
  });

  it('replaces plain placeholders and leaves unknown ones as they are', () => {
    expect(fillIssueTemplate('State {state} and {other}', { state: 'CA' })).toBe('State CA and {other}');
  });

  it('handles several optional parts independently', () => {
    const rules = 'Provisional rules[ in {state}][: {items}]; updated once final.';
    expect(fillIssueTemplate(rules, { state: 'NY' })).toBe('Provisional rules in NY; updated once final.');
    expect(fillIssueTemplate(rules, { items: 'FUTA' })).toBe('Provisional rules: FUTA; updated once final.');
    expect(fillIssueTemplate(rules, {})).toBe('Provisional rules; updated once final.');
  });
});

describe('parseNumberInput', () => {
  it('reads a decimal point or a decimal comma', () => {
    expect(parseNumberInput('12.5')).toBe(12.5);
    expect(parseNumberInput(' 12,5 ')).toBe(12.5);
  });

  it('treats blank as null and junk as NaN', () => {
    expect(parseNumberInput('  ')).toBeNull();
    expect(parseNumberInput('abc')).toBeNaN();
  });
});

describe('humanizeKey', () => {
  it('turns codes into words', () => {
    expect(humanizeKey('sui_rate')).toBe('Sui rate');
    expect(humanizeKey('bankIban')).toBe('Bank iban');
    expect(humanizeKey('nl.travel_allowance')).toBe('Nl travel allowance');
  });
});
