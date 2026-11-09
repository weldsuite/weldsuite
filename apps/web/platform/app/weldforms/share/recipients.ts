/** Parsing what someone pastes into the invite dialog's email box. */

import { isValidEmail } from '@weldsuite/forms-engine';

export interface ParsedRecipients {
  emails: Array<{ email: string; name?: string }>;
  /** Entries that are not an address. */
  invalid: string[];
}

const LINE_BREAK = /[\n\r\u2028\u2029]/;

/**
 * `Name <a@b.nl>` split at its last `<`: the text before it and the text
 * inside the brackets. Null when the entry is not in that form.
 */
function splitAngle(entry: string): { label: string; address: string } | null {
  const open = entry.lastIndexOf('<');
  if (open === -1 || !entry.endsWith('>')) return null;
  const label = entry.slice(0, open);
  const address = entry.slice(open + 1, -1);
  if (address === '' || address.includes('>') || LINE_BREAK.test(label)) return null;
  return { label, address };
}

/**
 * Splits on commas, semicolons and line breaks. An entry is `a@b.nl` or
 * `Name <a@b.nl>`; the same address twice counts once (the first name wins).
 */
export function parseRecipientText(text: string): ParsedRecipients {
  const emails: ParsedRecipients['emails'] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const raw of text.split(/[,;\n\r]+/)) {
    const entry = raw.trim();
    if (!entry) continue;

    let name: string | undefined;
    let address = entry;
    const angle = splitAngle(entry);
    if (angle) {
      address = angle.address.trim();
      const label = angle.label.trim().replace(/^"|"$/g, '').trim();
      if (label) name = label;
    }

    if (!isValidEmail(address)) {
      invalid.push(entry);
      continue;
    }
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    emails.push(name ? { email: address, name } : { email: address });
  }
  return { emails, invalid };
}
