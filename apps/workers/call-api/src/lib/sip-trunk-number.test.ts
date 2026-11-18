/**
 * Phone-number text of a customer's own phone system: what counts as a number
 * a member typed, and which number a call's `to` names (bare, `tel:`, a `sip:`
 * URI with or without `<>` and parameters).
 */

import { describe, expect, it } from 'vitest';
import { countryOfE164, dialedNumberOf, toTrunkE164 } from './sip-trunk-number';

describe('toTrunkE164', () => {
  it.each<[string, string | null]>([
    ['+31201234567', '+31201234567'],
    ['31201234567', '+31201234567'],
    ['0031 20 123 4567', '+31201234567'],
    ['+31 (0)20 123 45 67', '+310201234567'],
    ['  +31201234567  ', '+31201234567'],
    ['+0031201234567', null],
    ['00', null],
    ['+123456', null],
    ['+1234567', '+1234567'],
    ['+123456789012345', '+123456789012345'],
    ['+1234567890123456', null],
    ['', null],
    ['   ', null],
    ['abc', null],
    ['＋31201234567', '+31201234567'],
    ['٣١٢٠١٢٣٤٥٦٧', null],
  ])('reads %j as %j', (raw, expected) => {
    expect(toTrunkE164(raw)).toBe(expected);
  });
});

describe('dialedNumberOf', () => {
  it.each<[string, string | null]>([
    // What Telnyx sends
    ['+31201234567', '+31201234567'],
    ['31201234567', '+31201234567'],
    ['tel:+31-20-123-4567', '+31201234567'],
    ['sip:31201234567@sip.telnyx.com', '+31201234567'],
    ['sip:+31201234567@host;user=phone', '+31201234567'],
    ['SIPS:0031201234567@host:5061', '+31201234567'],
    ['<sip:+31201234567@host>', '+31201234567'],
    ['"Reception" <sip:+31201234567@host>;tag=abc', '+31201234567'],
    ['<sip:+31201234567;npdi@host>', '+31201234567'],
    ['  <tel:+31201234567>  ', '+31201234567'],
    // Nothing to read
    ['', null],
    ['   ', null],
    ['<', null],
    ['>', null],
    ['<>', null],
    ['sip:@host', null],
    ['sip:reception@host', null],
    // Everything from the first `>` of the last line goes
    ['+31201234567>garbage', '+31201234567'],
    ['+31201234567>>>', '+31201234567'],
    ['+3120>1234567', null],
    ['a>b>c', null],
    ['+31201234567>1>2', '+31201234567'],
    // A `>` followed by a line break further on stays, the digits after it count
    ['+3120>12\n34567', '+31201234567'],
    ['+3120>12\r34567', '+31201234567'],
    ['+3120>12 34567', '+31201234567'],
    ['+3120>12 34567', '+31201234567'],
    ['+3120>1\n2345>67', '+312012345'],
    ['+31201234567\n>99', '+31201234567'],
    ['>\n+31201234567', '+31201234567'],
    // Only the first `<` opens
    ['junk<junk<+31201234567', '+31201234567'],
    ['12<+31201234567>34', '+31201234567'],
    // Unicode
    ['<sip:＋31201234567@host>', '+31201234567'],
    ['sip:٣١٢٠١٢٣٤٥٦٧@host', null],
    ['"Zoë 😀" <sip:+31201234567@host>', '+31201234567'],
    // Long runs
    [`${'>'.repeat(5000)}`, null],
    [`+31201234567${'>'.repeat(5000)}\n`, '+31201234567'],
    [`${'>'.repeat(5000)}\n+31201234567`, '+31201234567'],
    [`${'<'.repeat(5000)}+31201234567`, '+31201234567'],
    [`${'x'.repeat(5000)}<sip:+31201234567@host>${'y'.repeat(5000)}`, '+31201234567'],
  ])('reads %j as %j', (raw, expected) => {
    expect(dialedNumberOf(raw)).toBe(expected);
  });
});

describe('countryOfE164', () => {
  it('names the country of a known prefix, the longest first', () => {
    expect(countryOfE164('+31201234567')).toBe('NL');
    expect(countryOfE164('+351210000000')).toBe('PT');
    expect(countryOfE164('+12125550100')).toBe('US');
    expect(countryOfE164('+81312345678')).toBe('INTL');
  });
});
