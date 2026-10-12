import { describe, expect, it } from 'vitest';
import { createReachFormat } from './format';

describe('createReachFormat', () => {
  it('renders the inbox price in the UI language', () => {
    expect(createReachFormat('en-US').money(500, 'usd')).toBe('$5');
    expect(createReachFormat('nl-NL').money(500, 'usd')).toMatch(/5/);
    expect(createReachFormat('en-US').money(1250, 'usd')).toBe('$12.50');
  });

  it('formats rates as percentages', () => {
    expect(createReachFormat('en-US').percent(0.034)).toBe('3.4%');
    expect(createReachFormat('en-US').percent(0)).toBe('0%');
  });

  it('describes a moment relative to now', () => {
    const format = createReachFormat('en-US');
    expect(format.relative(new Date(Date.now() - 3 * 60 * 1000).toISOString())).toBe('3 minutes ago');
    expect(format.relative(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + 5000).toISOString())).toBe('in 2 days');
  });
});
