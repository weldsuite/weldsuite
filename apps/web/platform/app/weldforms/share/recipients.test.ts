import { describe, expect, it } from 'vitest';
import { parseRecipientText } from './recipients';

describe('parseRecipientText', () => {
  it('splits on commas, semicolons and new lines', () => {
    const { emails, invalid } = parseRecipientText('a@x.nl, b@x.nl;c@x.nl\nd@x.nl');
    expect(emails.map((e) => e.email)).toEqual(['a@x.nl', 'b@x.nl', 'c@x.nl', 'd@x.nl']);
    expect(invalid).toEqual([]);
  });

  it('reads a name from the angle-bracket form', () => {
    expect(parseRecipientText('"Bram de Vries" <bram@x.nl>').emails).toEqual([{ email: 'bram@x.nl', name: 'Bram de Vries' }]);
  });

  it('keeps the first of a repeated address, whatever its case', () => {
    expect(parseRecipientText('Anna <a@x.nl>, A@X.NL').emails).toEqual([{ email: 'a@x.nl', name: 'Anna' }]);
  });

  it('reports what is not an address', () => {
    expect(parseRecipientText('nope, a@x.nl, also bad').invalid).toEqual(['nope', 'also bad']);
  });

  it('is empty for blank text', () => {
    expect(parseRecipientText('  \n ')).toEqual({ emails: [], invalid: [] });
  });
});
