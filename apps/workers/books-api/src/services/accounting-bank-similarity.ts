/**
 * Counterparty name matching for bank lines.
 *
 * US statements carry no IBAN, only free text such as "ACH CREDIT ACME CORP
 * INV 2001", so a line is matched to a contact by how much of the contact's
 * name the text holds. Names are normalized (case, punctuation, legal
 * suffixes, the bank's own payment-type words) and compared as token sets.
 */

const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company',
  'plc', 'pllc', 'pc', 'bv', 'nv', 'gmbh', 'ag', 'sa', 'sarl', 'the', 'and', 'of', 'dba',
]);

/** Words banks add to a description that say how the money moved, not who moved it. */
const BANK_NOISE = new Set([
  'ach', 'credit', 'debit', 'cr', 'dr', 'pmt', 'pymt', 'payment', 'payments', 'deposit', 'dep', 'web', 'ppd', 'ccd', 'ctx',
  'online', 'onl', 'transfer', 'xfer', 'wire', 'incoming', 'outgoing', 'from', 'to', 'ref', 'reference', 'id', 'check', 'chk',
  'pos', 'purchase', 'card', 'recurring', 'preauthorized', 'preauth', 'remote', 'mobile', 'bill', 'pay', 'trn', 'trace',
  'orig', 'co', 'name', 'inv', 'invoice', 'no', 'num', 'number', 'for', 'thank', 'you',
]);

/** Lower-case tokens of a name or description with punctuation, legal suffixes and bank noise removed. */
export function nameTokens(value: string | null | undefined, opts: { dropNoise?: boolean } = {}): string[] {
  if (!value) return [];
  const tokens = value
    .toLowerCase()
    .replaceAll('&', ' and ')
    .replaceAll(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    // Bare numbers (invoice numbers, store ids) say nothing about who the counterparty is.
    .filter((t) => !/^\d+$/.test(t))
    .filter((t) => !LEGAL_SUFFIXES.has(t));
  return opts.dropNoise ? tokens.filter((t) => !BANK_NOISE.has(t)) : tokens;
}

/** Two tokens match when equal, or when the longer starts with the shorter (at least 4 letters: "plumb" ~ "plumbing"). */
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

function coverage(needles: string[], haystack: string[]): number {
  if (needles.length === 0) return 0;
  const found = needles.filter((n) => haystack.some((h) => tokensMatch(n, h))).length;
  return found / needles.length;
}

/**
 * How well a bank line names a contact, 0 to 1.
 *
 * A counterparty name (OFX NAME, a feed's merchant) is compared both ways, so
 * "ACME CORP" against "Acme Corporation Inc" is a full match but "ACME" against
 * "Acme Roofing" is not. Free-text descriptions only need to *contain* the
 * contact's name, and score slightly lower for it.
 */
export function nameSimilarity(
  line: { counterpartyName?: string | null; description?: string | null },
  contactName: string | null | undefined,
): number {
  const contact = nameTokens(contactName);
  if (contact.length === 0) return 0;

  let best = 0;
  const counterparty = nameTokens(line.counterpartyName, { dropNoise: true });
  if (counterparty.length > 0) {
    best = (coverage(contact, counterparty) + coverage(counterparty, contact)) / 2;
  }
  const description = nameTokens(line.description, { dropNoise: true });
  if (description.length > 0) {
    // A one-word contact name found in a long description is a weak signal.
    const held = coverage(contact, description);
    const weight = contact.length === 1 && description.length > 4 ? 0.7 : 0.9;
    best = Math.max(best, held * weight);
  }
  return Math.round(best * 100) / 100;
}

/** Confidence added to a match for how well the names agree. */
export function nameConfidence(similarity: number): { confidence: number; reason: string } | null {
  if (similarity >= 0.8) return { confidence: 0.3, reason: 'name matches' };
  if (similarity >= 0.5) return { confidence: 0.15, reason: 'name partly matches' };
  return null;
}

/** Days between two dates, ignoring the time of day. */
export function daysApart(a: Date | string, b: Date | string): number {
  const day = (v: Date | string) => Math.floor(new Date(v).getTime() / 86_400_000);
  return Math.abs(day(a) - day(b));
}
