/** Parsing the "add to the suppression list" textarea. */

// The domain part is split at its first dot after the first character (`[^\s@][^\s@.]*\.`), so every
// character can be matched in only one way: linear time, same matches as `[^\s@]+\.[^\s@]{2,}`.
const EMAIL_RE = /^[^\s@]+@[^\s@][^\s@.]*\.[^\s@]{2,}$/;
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

/** Split pasted text (newlines, commas, spaces) into unique lower-case values; `invalid` are neither an email address nor a domain. */
export function parseSuppressionInput(text: string): { values: string[]; invalid: string[] } {
  const unique = [...new Set(text.split(/[\s,;]+/).map((value) => value.trim().toLowerCase()).filter(Boolean))];
  return {
    values: unique.filter((value) => EMAIL_RE.test(value) || DOMAIN_RE.test(value)),
    invalid: unique.filter((value) => !EMAIL_RE.test(value) && !DOMAIN_RE.test(value)),
  };
}
