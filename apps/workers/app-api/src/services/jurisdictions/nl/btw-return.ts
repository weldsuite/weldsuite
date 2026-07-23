import type { Entity } from '@weldsuite/db/schema';
import type { TaxReturnArtifact, TaxReturnLine } from '../types';
import { generateVatXml, type VatXmlInput } from '../../accounting-vat-xml';

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
  const rubrieken = {
    r1a: 0, r1b: 0, r1c: 0, r1d: 0, r1e: 0, r1f: 0,
    r2a: 0,
    r3a: 0, r3b: 0, r3c: 0,
    r4a: 0, r4b: 0,
    r5a: 0, r5b: 0, r5c: 0, r5d: 0, r5e: 0, r5f: 0,
  };

  for (const line of lines) {
    const code = (line.jurisdictionMetadata?.btwRubriek as string | undefined) ?? '';
    switch (code) {
      case '1a': rubrieken.r1a += line.taxableAmount; rubrieken.r1b += line.taxAmount; break;
      case '1c': rubrieken.r1c += line.taxableAmount; rubrieken.r1d += line.taxAmount; break;
      case '1e': rubrieken.r1e += line.taxableAmount; rubrieken.r1f += line.taxAmount; break;
      case '2a': rubrieken.r2a += line.taxableAmount; break;
      case '3a': rubrieken.r3a += line.taxableAmount; break;
      case '3b': rubrieken.r3b += line.taxableAmount; break;
      case '3c': rubrieken.r3c += line.taxableAmount; break;
      case '4a': rubrieken.r4a += line.taxableAmount; break;
      case '4b': rubrieken.r4b += line.taxableAmount; break;
      case '5b': rubrieken.r5b += line.taxAmount; break;
    }
  }

  rubrieken.r5a = rubrieken.r1b + rubrieken.r1d + rubrieken.r1f;
  rubrieken.r5c = rubrieken.r5a - rubrieken.r5b;
  rubrieken.r5f = rubrieken.r5c - rubrieken.r5d - rubrieken.r5e;

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
