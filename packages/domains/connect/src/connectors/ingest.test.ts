import { describe, it, expect } from 'vitest';
import { sanitiseErrorMessage } from './ingest';

describe('sanitiseErrorMessage', () => {
  it.each([
    ['Key (sku)=(ABC-1) already exists.', 'Key (sku)=(redacted) already exists.'],
    ['Key (a, b)=(1, 2) already exists.', 'Key (a, b)=(redacted) already exists.'],
    ['Key (lower(email::text))=(a@b.com) already exists.', 'Key (lower(email::text))=(redacted) already exists.'],
    ["value 'secret' too long", "value 'redacted' too long"],
  ])('redacts values in %s', (message, expected) => {
    expect(sanitiseErrorMessage(new Error(message))).toBe(expected);
  });
});
