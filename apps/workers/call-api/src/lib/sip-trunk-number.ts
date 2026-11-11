/**
 * Phone-number text of a customer's own phone system: what a member types and
 * what arrives in a call's `to` (`+3120…`, `0031 20…`, `sip:31201234567@host`).
 */

const E164 = /^\+[1-9]\d{6,14}$/;

/** `+<digits>` from a typed or dialled number, tolerating a missing `+` and a `00` prefix; null when it is not a plausible E.164 number. */
export function toTrunkE164(raw: string): string | null {
  let text = raw.trim();
  if (text === '') return null;
  const hasPlus = text.startsWith('+');
  let digits = text.replace(/\D/g, '');
  if (!hasPlus && digits.startsWith('00')) digits = digits.slice(2);
  text = `+${digits}`;
  return E164.test(text) ? text : null;
}

const LINE_BREAKS = ['\n', '\r', ' ', ' '];

/** The text up to the first `>` of its last line: what `/>.*$/` took off, without its backtracking. */
function beforeClosingBracket(value: string): string {
  const lastBreak = Math.max(...LINE_BREAKS.map((ch) => value.lastIndexOf(ch)));
  const close = value.indexOf('>', lastBreak + 1);
  return close < 0 ? value : value.slice(0, close);
}

/** The number in a call's `to`: a bare number, `tel:` or the user part of a `sip:` URI (parameters and `<>` dropped). */
export function dialedNumberOf(raw: string): string | null {
  let value = beforeClosingBracket(raw.trim().replace(/^[^<]*</, ''));
  value = value.replace(/^(sips?|tel):/i, '');
  const at = value.indexOf('@');
  if (at >= 0) value = value.slice(0, at);
  value = value.split(';')[0] ?? '';
  return toTrunkE164(value);
}

const COUNTRY_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['+351', 'PT'], ['+352', 'LU'], ['+353', 'IE'], ['+358', 'FI'],
  ['+31', 'NL'], ['+32', 'BE'], ['+33', 'FR'], ['+34', 'ES'], ['+39', 'IT'], ['+41', 'CH'],
  ['+43', 'AT'], ['+44', 'GB'], ['+45', 'DK'], ['+46', 'SE'], ['+47', 'NO'], ['+48', 'PL'], ['+49', 'DE'],
  ['+1', 'US'],
];

/** A best-effort country for a number row (`INTL` when the prefix is not one we know). */
export function countryOfE164(e164: string): string {
  for (const [prefix, country] of COUNTRY_PREFIXES) {
    if (e164.startsWith(prefix)) return country;
  }
  return 'INTL';
}
