/** One `@`, something before it, and a dot inside the domain with text on both sides. */
function isEmail(value: string): boolean {
  const at = value.indexOf('@');
  if (at < 1 || at !== value.lastIndexOf('@')) return false;
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

export interface ParsedRecipients {
  /** Distinct, lower-cased addresses in the order typed. */
  valid: string[];
  invalid: string[];
}

/** Splits "a@x.com, b@y.com c@z.com" into addresses, separating the ones that are not an address. */
export function parseRecipients(text: string): ParsedRecipients {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const part of text.split(/[\s,;]+/)) {
    const address = part.trim();
    if (address === '') continue;
    if (isEmail(address)) {
      const lower = address.toLowerCase();
      if (!valid.includes(lower)) valid.push(lower);
    } else {
      invalid.push(address);
    }
  }
  return { valid, invalid };
}
