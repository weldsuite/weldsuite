import type { Entity, VatRubrieken } from '@weldsuite/db/schema';
import type { TaxReturnArtifact, TaxReturnLine } from '../types';
import { generateVatXml, type VatXmlInput } from '../../accounting-vat-xml';

function emptyRubrieken(): VatRubrieken {
  return {
    r1a: 0, r1b: 0, r1c: 0, r1d: 0, r1e: 0, r1f: 0,
    r2a: 0,
    r3a: 0, r3b: 0, r3c: 0,
    r4a: 0, r4b: 0,
    r5a: 0, r5b: 0, r5c: 0, r5d: 0, r5e: 0, r5f: 0,
  };
}

/** Purchase rubrieken: base amounts the buyer reports itself (reverse charge, EU and non-EU acquisitions). */
const PURCHASE_BASE_RUBRIEKEN = new Set(['2a', '4a', '4b']);

/**
 * The 18 rubrieken of the Dutch BTW return from tax-ledger lines.
 *
 * Sales lines go to the rubriek of their rate (`jurisdictionMetadata.btwRubriek`).
 * Purchase lines are voorbelasting (5b) — whatever their rate's rubriek, so a
 * "both" rate like 21% hoog used on a bill counts as input tax, not turnover —
 * except reverse-charge and acquisition rates (2a, 4a, 4b), which report their
 * base there. Their self-assessed tax is owed and deducted at once; the XBRL
 * has no tax fields for 2a/4a/4b, so it stays out of 5a and 5b (net zero).
 */
export function computeNlRubrieken(lines: TaxReturnLine[]): VatRubrieken {
  const rubrieken = emptyRubrieken();

  for (const line of lines) {
    const code = (line.jurisdictionMetadata?.btwRubriek as string | undefined) ?? '';
    const direction = line.direction ?? (code === '5b' || PURCHASE_BASE_RUBRIEKEN.has(code) ? 'purchase' : 'sales');

    if (direction === 'purchase') {
      if (PURCHASE_BASE_RUBRIEKEN.has(code)) {
        if (code === '2a') rubrieken.r2a += line.taxableAmount;
        if (code === '4a') rubrieken.r4a += line.taxableAmount;
        if (code === '4b') rubrieken.r4b += line.taxableAmount;
      } else if (!line.selfAssessed) {
        rubrieken.r5b += line.taxAmount;
      }
      continue;
    }

    switch (code) {
      case '1a': rubrieken.r1a += line.taxableAmount; rubrieken.r1b += line.taxAmount; break;
      case '1c': rubrieken.r1c += line.taxableAmount; rubrieken.r1d += line.taxAmount; break;
      case '1e': rubrieken.r1e += line.taxableAmount; rubrieken.r1f += line.taxAmount; break;
      case '3a': rubrieken.r3a += line.taxableAmount; break;
      case '3b': rubrieken.r3b += line.taxableAmount; break;
      case '3c': rubrieken.r3c += line.taxableAmount; break;
    }
  }

  rubrieken.r5a = rubrieken.r1b + rubrieken.r1d + rubrieken.r1f;
  rubrieken.r5c = rubrieken.r5a - rubrieken.r5b;
  rubrieken.r5f = rubrieken.r5c - rubrieken.r5d - rubrieken.r5e;

  for (const key of Object.keys(rubrieken) as Array<keyof VatRubrieken>) {
    rubrieken[key] = Math.round(rubrieken[key] * 100) / 100;
  }
  return rubrieken;
}

/**
 * Map generic tax return lines into the 18-rubriek structure the Belastingdienst expects,
 * then render as XBRL via the existing generateVatXml() service.
 */
export async function buildNlBtwReturn(
  entity: Entity,
  periodStart: string,
  periodEnd: string,
  lines: TaxReturnLine[],
): Promise<TaxReturnArtifact> {
  const rubrieken = computeNlRubrieken(lines);

  const xmlInput: VatXmlInput = {
    btwNumber: entity.taxIdentifiers?.vatNumber ?? '',
    companyName: entity.legalName ?? entity.name,
    contactName: entity.contact?.email ?? entity.name,
    contactPhone: entity.contact?.phone ?? '',
    periodStart,
    periodEnd,
    rubrieken,
  };

  const xml = generateVatXml(xmlInput);

  return {
    filename: `btw-aangifte-${periodStart}-${periodEnd}.xml`,
    mimeType: 'application/xml',
    content: xml,
    summary: rubrieken as unknown as Record<string, number>,
  };
}
