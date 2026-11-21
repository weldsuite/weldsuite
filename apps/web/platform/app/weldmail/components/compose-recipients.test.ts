import { describe, expect, it } from 'vitest';
import { isValidRecipient, withPendingInput } from './compose-recipients';

describe('isValidRecipient', () => {
  it.each(['ann@example.com', 'ann.lee+news@mail.example.co.uk', ' ann@example.com ', 'Ann Lee <ann@example.com>'])(
    'accepts %s',
    (value) => {
      expect(isValidRecipient(value)).toBe(true);
    },
  );

  it.each(['ann', 'ann@', 'ann@example', '@example.com', 'ann lee@example.com', 'Ann Lee <ann>', 'Ann Lee'])(
    'rejects %s',
    (value) => {
      expect(isValidRecipient(value)).toBe(false);
    },
  );
});

describe('withPendingInput', () => {
  it('adds the typed text to the recipients', () => {
    expect(withPendingInput(['ann@example.com'], ' bo ')).toEqual(['ann@example.com', 'bo']);
  });

  it('leaves the recipients alone when nothing is typed', () => {
    expect(withPendingInput(['ann@example.com'], '  ')).toEqual(['ann@example.com']);
  });
});
