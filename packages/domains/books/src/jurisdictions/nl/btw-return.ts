import type { Entity, VatRubrieken } from '@weldsuite/db/schema';
import type { TaxReturnArtifact, TaxReturnLine } from '../types';
import { generateVatXml, type VatXmlInput } from '../../accounting-vat-xml';

export function emptyRubrieken(): VatRubrieken {
  return {
    r1a: 0, r1aBtw: 0,
    r1b: 0, r1bBtw: 0,
    r1c: 0, r1cBtw: 0,
    r1d: 0, r1dBtw: 0,
    r1e: 0,
    r2a: 0, r2aBtw: 0,
    r3a: 0, r3b: 0, r3c: 0,
    r4a: 0, r4aBtw: 0,
    r4b: 0, r4bBtw: 0,
    r5a: 0, r5b: 0, r5c: 0, r5d: 0, r5e: 0, r5f: 0, r5g: 0,
  };
}

/**
 * Purchase rubrieken: the buyer reports the base itself (reverse charge, EU and
 * non-EU acquisitions). The BTW it owes on them is part of 5a and, when it is
 * deductible, deducted again in 5b.
 */
const PURCHASE_BASE_RUBRIEKEN = new Set(['2a', '4a', '4b']);

/** The turnover / BTW key pairs of the sales rubrieken. */
const SALES_RUBRIEKEN = {
  '1a': ['r1a', 'r1aBtw'],
  '1b': ['r1b', 'r1bBtw'],
  '1c': ['r1c', 'r1cBtw'],
  '1d': ['r1d', 'r1dBtw'],
} as const;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The rubriek a ledger line belongs to. Tax rates created before the official
 * numbering was adopted carry the old codes: laag tarief as '1c' and a 0% rate
 * as '1e' (which used to hold "other rates" with their BTW), so a '1c' line of
 * the reduced category is 1b, and a '1e' line that carries BTW is 1c.
 */
export function resolveNlRubriek(line: Pick<TaxReturnLine, 'taxCategoryCode' | 'taxAmount' | 'jurisdictionMetadata'>): string {
  const code = (line.jurisdictionMetadata?.btwRubriek as string | undefined) ?? '';
  if (code === '1c' && line.taxCategoryCode === 'reduced') return '1b';
  if (code === '1e' && line.taxAmount !== 0) return '1c';
  return code;
}

/**
 * Recompute the derived totals (5a, 5c, 5g) from the box amounts. 5b is an
 * input (voorbelasting, plus the deductible BTW of 2a/4a/4b added by the
 * calculation); 5d, 5e and 5f are manual boxes.
 */
export function recomputeRubriekTotals(r: VatRubrieken): VatRubrieken {
  const next = { ...r };
  next.r5a = round2(next.r1aBtw + next.r1bBtw + next.r1cBtw + next.r1dBtw + next.r2aBtw + next.r4aBtw + next.r4bBtw);
  next.r5c = round2(next.r5a - next.r5b);
  next.r5g = round2(next.r5c - next.r5d - next.r5e + next.r5f);
  return next;
}

/** Whether a line is a sale or a purchase; lines without a stated direction follow their rubriek. */
function lineDirection(line: TaxReturnLine, code: string): 'sales' | 'purchase' {
  if (line.direction) return line.direction;
  return code === '5b' || PURCHASE_BASE_RUBRIEKEN.has(code) ? 'purchase' : 'sales';
}

/** A reverse-charge or acquisition line: its base and the BTW the buyer owes on it. */
function addAcquisitionLine(rubrieken: VatRubrieken, code: string, line: TaxReturnLine) {
  if (code === '2a') {
    rubrieken.r2a += line.taxableAmount;
    rubrieken.r2aBtw += line.taxAmount;
  } else if (code === '4a') {
    rubrieken.r4a += line.taxableAmount;
    rubrieken.r4aBtw += line.taxAmount;
  } else {
    rubrieken.r4b += line.taxableAmount;
    rubrieken.r4bBtw += line.taxAmount;
  }
}

/** A purchase line: voorbelasting (5b), except self-assessed tax; an acquisition also reports its base. */
function addPurchaseLine(rubrieken: VatRubrieken, code: string, line: TaxReturnLine) {
  if (PURCHASE_BASE_RUBRIEKEN.has(code)) {
    addAcquisitionLine(rubrieken, code, line);
    rubrieken.r5b += line.taxAmount;
  } else if (!line.selfAssessed) {
    rubrieken.r5b += line.taxAmount;
  }
}

/** A sales line: omzet (and BTW) of the rubriek it belongs to. */
function addSalesLine(rubrieken: VatRubrieken, code: string, line: TaxReturnLine) {
  if (code in SALES_RUBRIEKEN) {
    const [base, btw] = SALES_RUBRIEKEN[code as keyof typeof SALES_RUBRIEKEN];
    rubrieken[base] += line.taxableAmount;
    rubrieken[btw] += line.taxAmount;
    return;
  }
  switch (code) {
    case '1e': rubrieken.r1e += line.taxableAmount; break;
    case '3a': rubrieken.r3a += line.taxableAmount; break;
    case '3b': rubrieken.r3b += line.taxableAmount; break;
    case '3c': rubrieken.r3c += line.taxableAmount; break;
  }
}

/**
 * The boxes of the Dutch BTW return from tax-ledger lines.
 *
 * Sales lines go to the rubriek of their rate (`jurisdictionMetadata.btwRubriek`):
 * 1a hoog, 1b laag, 1c overige tarieven, 1d privégebruik (omzet + BTW), 1e 0%
 * or not taxed, 3a/3b/3c (omzet only). Purchase lines are voorbelasting (5b) —
 * whatever their rate's rubriek, so a "both" rate like 21% hoog used on a bill
 * counts as input tax, not turnover — except reverse-charge and acquisition
 * rates (2a, 4a, 4b), which report their base AND the BTW the buyer owes on it.
 * That BTW is owed (5a) and deducted again (5b), a net zero when deductible; a
 * ledger line only exists for deductible tax.
 */
export function computeNlRubrieken(lines: TaxReturnLine[]): VatRubrieken {
  const rubrieken = emptyRubrieken();

  for (const line of lines) {
    const code = resolveNlRubriek(line);
    if (lineDirection(line, code) === 'purchase') addPurchaseLine(rubrieken, code, line);
    else addSalesLine(rubrieken, code, line);
  }

  for (const key of Object.keys(rubrieken) as Array<keyof VatRubrieken>) {
    rubrieken[key] = round2(rubrieken[key]);
  }
  return recomputeRubriekTotals(rubrieken);
}

/**
 * Read stored rubrieken in the current layout. Returns stored before the
 * official numbering (`r1a`..`r1f` in pairs, `r5f` as the total) are converted:
 * old 1a/1b = hoog omzet/BTW, 1c/1d = laag omzet/BTW (now 1b), 1e/1f = "other
 * rates" omzet/BTW (now 1c, or 1e when it carried no BTW, i.e. 0%), 5f = total
 * (now 5g). A current-layout object only gets missing keys filled with 0.
 */
export function normalizeVatRubrieken(raw: unknown): VatRubrieken | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  const n = (key: string) => {
    const value = Number(src[key]);
    return Number.isFinite(value) ? value : 0;
  };

  const isLegacy = !('r5g' in src) && !('r1aBtw' in src) && ('r1f' in src || 'r1b' in src || 'r5f' in src);
  if (!isLegacy) {
    const out = emptyRubrieken();
    for (const key of Object.keys(out) as Array<keyof VatRubrieken>) out[key] = n(key);
    return out;
  }

  const out = emptyRubrieken();
  out.r1a = n('r1a');
  out.r1aBtw = n('r1b');
  out.r1b = n('r1c');
  out.r1bBtw = n('r1d');
  if (n('r1f') !== 0) {
    out.r1c = n('r1e');
    out.r1cBtw = n('r1f');
  } else {
    out.r1e = n('r1e');
  }
  out.r2a = n('r2a');
  out.r3a = n('r3a');
  out.r3b = n('r3b');
  out.r3c = n('r3c');
  out.r4a = n('r4a');
  out.r4b = n('r4b');
  out.r5a = n('r5a');
  out.r5b = n('r5b');
  out.r5c = n('r5c');
  out.r5d = n('r5d');
  out.r5e = n('r5e');
  out.r5g = n('r5f');
  return out;
}

/**
 * Map generic tax return lines into the box structure the Belastingdienst
 * expects, then render as XBRL via the existing generateVatXml() service.
 */
export function buildNlBtwReturn(
  entity: Entity,
  periodStart: string,
  periodEnd: string,
  lines: TaxReturnLine[],
): Promise<TaxReturnArtifact> {
  const rubrieken = computeNlRubrieken(lines);

  const xmlInput: VatXmlInput = {
    btwNumber: entity.taxIdentifiers?.vatNumber ?? '',
    companyName: entity.legalName ?? entity.name,
    contactName: entity.legalName ?? entity.name,
    contactPhone: entity.contact?.phone ?? '',
    periodStart,
    periodEnd,
    rubrieken,
  };

  const xml = generateVatXml(xmlInput);

  return Promise.resolve({
    filename: `btw-aangifte-${periodStart}-${periodEnd}.xml`,
    mimeType: 'application/xml',
    content: xml,
    summary: rubrieken as unknown as Record<string, number>,
  });
}
