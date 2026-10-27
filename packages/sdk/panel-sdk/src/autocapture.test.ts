import { describe, expect, it } from 'vitest';
import { maskText } from './autocapture';

describe('maskText', () => {
  it('masks an address, punctuation and all', () => {
    expect(maskText('Mail jane@acme.com today')).toBe('Mail * today');
    expect(maskText('Write to (jane@acme.com)')).toBe('Write to *');
  });

  it('masks an address that ends a sentence with a dot', () => {
    expect(maskText('Mail support@acme.com.')).toBe('Mail *');
  });

  it('masks several addresses run together', () => {
    expect(maskText('cc a@x.com,b@y.com')).toBe('cc *');
  });

  it('leaves words that only look a bit like an address', () => {
    expect(maskText('Follow @weldsuite')).toBe('Follow @weldsuite');
    expect(maskText('a@b and a@.com and a@b.')).toBe('a@b and a@.com and a@b.');
  });

  it('masks runs of 4 or more digits', () => {
    expect(maskText('Pay 4242 4242 4242 4242, order 123')).toBe('Pay * * * *, order 123');
  });
});
