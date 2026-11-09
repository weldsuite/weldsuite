/** Parsing what someone pastes into the invite dialog's email box. */

import { isValidEmail } from '@weldsuite/forms-engine';

export interface ParsedRecipients {
  emails: Array<{ email: string; name?: string }>;
  /** Entries that are not an address. */
  invalid: string[];
}

const ANGLE_RE = /^(.*?)<\s*([^<>]+?)\s*>$/;

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
    const angle = ANGLE_RE.exec(entry);
    if (angle) {
      address = angle[2]?.trim() ?? '';
      const label = angle[1]?.trim().replace(/^"|"$/g, '').trim();
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
