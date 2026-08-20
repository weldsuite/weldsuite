export type MarkupKind = 'none' | 'percent' | 'amount';

export type MarkupPatch = {
  markupAmount: number | null;
  markupPercent: string | null;
};

export function parseMarkupInput(
  kind: string,
  rawValue: string,
): { ok: true; data: MarkupPatch } | { ok: false; code: 'invalid' | 'out_of_range' } {
  if (kind === 'none') {
    return { ok: true, data: { markupAmount: null, markupPercent: null } };
  }

  const normalized = rawValue.trim().replace(',', '.');
  if (!normalized) return { ok: false, code: 'invalid' };
  const n = Number.parseFloat(normalized);
  if (!Number.isFinite(n) || n < 0) return { ok: false, code: 'invalid' };

  if (kind === 'percent') {
    if (n > 999.99) return { ok: false, code: 'out_of_range' };
    return { ok: true, data: { markupAmount: null, markupPercent: n.toFixed(2) } };
  }

  if (kind === 'amount') {
    const cents = Math.round(n * 100);
    if (cents > 99_999_999) return { ok: false, code: 'out_of_range' };
    return { ok: true, data: { markupAmount: cents, markupPercent: null } };
  }

  return { ok: false, code: 'invalid' };
}

export function customerPriceMajor(
  wholesaleMajor: string,
  markup: { markupAmount: number | null; markupPercent: string | null },
): string | null {
  const major = Number.parseFloat(wholesaleMajor);
  if (!Number.isFinite(major)) return null;
  let sell = major;
  if (markup.markupAmount != null) {
    sell = major + markup.markupAmount / 100;
  } else if (markup.markupPercent != null) {
    const pct = Number.parseFloat(markup.markupPercent);
    if (Number.isFinite(pct)) sell = major * (1 + pct / 100);
  }
  return sell.toFixed(2);
}

export function markupKindOf(row: {
  markupAmount: number | null;
  markupPercent: string | null;
}): MarkupKind {
  if (row.markupAmount != null) return 'amount';
  if (row.markupPercent != null) return 'percent';
  return 'none';
}

export function markupValueOf(row: {
  markupAmount: number | null;
  markupPercent: string | null;
}): string {
  if (row.markupAmount != null) return (row.markupAmount / 100).toFixed(2);
  if (row.markupPercent != null) return String(Number.parseFloat(row.markupPercent));
  return '';
}

/** `domain_pricing` numeric(10, 2) — 8 digits before the decimal. */
const PRICE_MAJOR_MAX = 99_999_999.99;

export function parsePriceMajor(
  raw: string,
): { ok: true; value: string } | { ok: false; code: 'invalid' | 'out_of_range' } {
  const normalized = raw.trim().replace(',', '.');
  if (!normalized) return { ok: false, code: 'invalid' };
  const n = Number.parseFloat(normalized);
  if (!Number.isFinite(n) || n < 0) return { ok: false, code: 'invalid' };
  if (n > PRICE_MAJOR_MAX) return { ok: false, code: 'out_of_range' };
  return { ok: true, value: n.toFixed(2) };
}

const TLD_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function parseTldInput(
  raw: string,
): { ok: true; tld: string } | { ok: false; code: 'invalid' } {
  const tld = raw.trim().replace(/^\./, '').toLowerCase();
  if (!tld || tld.length > 50 || !TLD_RE.test(tld)) return { ok: false, code: 'invalid' };
  return { ok: true, tld };
}
