import { describe, expect, it } from 'vitest';
import { errorMessage, humanizeKey } from './labels';

describe('humanizeKey', () => {
  it('turns camelCase and snake_case argument names into labels', () => {
    expect(humanizeKey('lastName')).toBe('Last name');
    expect(humanizeKey('first_name')).toBe('First name');
    expect(humanizeKey('email')).toBe('Email');
    expect(humanizeKey('dueDate.start')).toBe('Due date start');
  });

  it('keeps an acronym run together', () => {
    expect(humanizeKey('HTMLBody')).toBe('Html body');
  });
});

describe('errorMessage', () => {
  it('prefers the error text, then the fallback', () => {
    expect(errorMessage(new Error('Nope'), 'Fallback')).toBe('Nope');
    expect(errorMessage({}, 'Fallback')).toBe('Fallback');
  });
});
