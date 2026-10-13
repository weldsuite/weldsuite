/**
 * Generate SBR/XBRL XML for the Dutch BTW-aangifte (aangifte omzetbelasting).
 *
 * Produces an XBRL 2.1 instance for the Belastingdienst's `bd-rpt-ob-aangifte`
 * entrypoint of the period's year (see `jurisdictions/nl/taxonomy.ts`). Element
 * names are those of the `bd-data` dictionary (prefix `bd-i`), checked against
 * the presentation linkbase `bd-ob-aangifte-pre.xml` of NT20:
 *
 *   box  turnover element                                         BTW element
 *   1a   TaxedTurnoverSuppliesServicesGeneralTariff               ValueAddedTaxSuppliesServicesGeneralTariff
 *   1b   TaxedTurnoverSuppliesServicesReducedTariff               ValueAddedTaxSuppliesServicesReducedTariff
 *   1c   TaxedTurnoverSuppliesServicesOtherRates                  ValueAddedTaxSuppliesServicesOtherRates
 *   1d   TaxedTurnoverPrivateUse                                  ValueAddedTaxPrivateUse
 *   1e   SuppliesServicesNotTaxed                                 -
 *   2a   TurnoverSuppliesServicesByWhichVATTaxationIsTransferred  ValueAddedTaxSuppliesServicesByWhichVATTaxationIsTransferred
 *   3a   SuppliesToCountriesOutsideTheEC                          -
 *   3b   SuppliesToCountriesWithinTheEC                           -
 *   3c   InstallationDistanceSalesWithinTheEC                     -
 *   4a   TurnoverFromTaxedSuppliesFromCountriesOutsideTheEC       ValueAddedTaxOnSuppliesFromCountriesOutsideTheEC
 *   4b   TurnoverFromTaxedSuppliesFromCountriesWithinTheEC        ValueAddedTaxOnSuppliesFromCountriesWithinTheEC
 *   5a   ValueAddedTaxOwed
 *   5b   ValueAddedTaxOnInput
 *   5c   ValueAddedTaxOwedToBePaidBack
 *
 * 5d (KOR reduction), 5e / 5f (estimates) and 5g (total) are not part of the
 * electronic message: the Belastingdienst derives them.
 */

import { nlTaxonomyUris } from './jurisdictions/nl/taxonomy';

export interface VatXmlRubrieken {
  r1a: number;
  r1aBtw: number;
  r1b: number;
  r1bBtw: number;
  r1c: number;
  r1cBtw: number;
  r1d: number;
  r1dBtw: number;
  r1e: number;
  r2a: number;
  r2aBtw: number;
  r3a: number;
  r3b: number;
  r3c: number;
  r4a: number;
  r4aBtw: number;
  r4b: number;
  r4bBtw: number;
  r5a: number;
  r5b: number;
}

export interface VatXmlInput {
  btwNumber: string; // e.g. "NL123456789B01"
  companyName: string;
  contactName: string;
  contactPhone: string;
  periodStart: string; // ISO date
  periodEnd: string; // ISO date
  rubrieken: VatXmlRubrieken;
  /** Unique reference of this message (MessageReferenceSupplierVAT). Defaults to `OB-<start>-<end>`. */
  messageReference?: string;
}

/**
 * Escape XML special characters in a string value.
 */
function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&apos;');
}

/** Whole euros, as the Belastingdienst requires. */
function roundToWholeEuros(value: number): number {
  return Math.round(value) || 0;
}

/**
 * The amounts as filed: every box in whole euros, with 5a and 5c recomputed
 * from the rounded boxes so the message adds up exactly.
 */
export function wholeEuroRubrieken(r: VatXmlRubrieken): VatXmlRubrieken {
  const out = { ...r };
  for (const key of Object.keys(out) as Array<keyof VatXmlRubrieken>) out[key] = roundToWholeEuros(out[key]);
  out.r5a = out.r1aBtw + out.r1bBtw + out.r1cBtw + out.r1dBtw + out.r2aBtw + out.r4aBtw + out.r4bBtw;
  return out;
}

/** The initials of a name, for the (mandatory) ContactInitials element. */
function initialsOf(name: string): string {
  const letters = name
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}]/gu, '')[0])
    .filter(Boolean)
    .join('')
    .toUpperCase();
  return (letters || 'X').slice(0, 10);
}

/** Digits and `+` only, at most 14 characters (anstring14V). */
function telephoneOf(phone: string): string {
  return phone.replace(/[^\d+]/g, '').slice(0, 14);
}

/** The Belastingdienst's entity scheme for an omzetbelastingnummer. */
export const OMZETBELASTINGNUMMER_SCHEME = 'http://www.belastingdienst.nl/omzetbelastingnummer';

/**
 * Generate the XBRL instance document for a Dutch BTW-aangifte.
 */
export function generateVatXml(input: VatXmlInput): string {
  const now = new Date().toISOString();
  const periodStartDate = input.periodStart.slice(0, 10);
  const periodEndDate = input.periodEnd.slice(0, 10);
  const taxonomy = nlTaxonomyUris(periodStartDate);

  const r = wholeEuroRubrieken(input.rubrieken);

  const escapedContactName = escapeXml(input.contactName.slice(0, 200));
  const escapedInitials = escapeXml(initialsOf(input.contactName));
  const phone = telephoneOf(input.contactPhone);
  const escapedBtwNumber = escapeXml(input.btwNumber);
  const reference = escapeXml((input.messageReference ?? `OB-${periodStartDate}-${periodEndDate}`).slice(0, 200));

  const amount = (element: string, value: number) =>
    `  <bd-i:${element} contextRef="Msg" unitRef="EUR" decimals="0">${value}</bd-i:${element}>`;

  const facts = [
    '  <!-- 1. Prestaties binnenland -->',
    '  <!-- 1a: hoog tarief -->',
    amount('TaxedTurnoverSuppliesServicesGeneralTariff', r.r1a),
    amount('ValueAddedTaxSuppliesServicesGeneralTariff', r.r1aBtw),
    '  <!-- 1b: laag tarief -->',
    amount('TaxedTurnoverSuppliesServicesReducedTariff', r.r1b),
    amount('ValueAddedTaxSuppliesServicesReducedTariff', r.r1bBtw),
    '  <!-- 1c: overige tarieven, behalve 0% -->',
    amount('TaxedTurnoverSuppliesServicesOtherRates', r.r1c),
    amount('ValueAddedTaxSuppliesServicesOtherRates', r.r1cBtw),
    '  <!-- 1d: privégebruik -->',
    amount('TaxedTurnoverPrivateUse', r.r1d),
    amount('ValueAddedTaxPrivateUse', r.r1dBtw),
    '  <!-- 1e: 0% of niet bij u belast -->',
    amount('SuppliesServicesNotTaxed', r.r1e),
    '  <!-- 2. Verleggingsregelingen binnenland -->',
    amount('TurnoverSuppliesServicesByWhichVATTaxationIsTransferred', r.r2a),
    amount('ValueAddedTaxSuppliesServicesByWhichVATTaxationIsTransferred', r.r2aBtw),
    '  <!-- 3. Prestaties naar of in het buitenland -->',
    '  <!-- 3a: leveringen naar landen buiten de EU -->',
    amount('SuppliesToCountriesOutsideTheEC', r.r3a),
    '  <!-- 3b: leveringen naar / diensten in landen binnen de EU -->',
    amount('SuppliesToCountriesWithinTheEC', r.r3b),
    '  <!-- 3c: installatie / afstandsverkopen binnen de EU -->',
    amount('InstallationDistanceSalesWithinTheEC', r.r3c),
    '  <!-- 4. Prestaties vanuit het buitenland aan u verricht -->',
    '  <!-- 4a: uit landen buiten de EU -->',
    amount('TurnoverFromTaxedSuppliesFromCountriesOutsideTheEC', r.r4a),
    amount('ValueAddedTaxOnSuppliesFromCountriesOutsideTheEC', r.r4aBtw),
    '  <!-- 4b: uit landen binnen de EU -->',
    amount('TurnoverFromTaxedSuppliesFromCountriesWithinTheEC', r.r4b),
    amount('ValueAddedTaxOnSuppliesFromCountriesWithinTheEC', r.r4bBtw),
    '  <!-- 5. Berekening -->',
    '  <!-- 5a: verschuldigde omzetbelasting -->',
    amount('ValueAddedTaxOwed', r.r5a),
    '  <!-- 5b: voorbelasting -->',
    amount('ValueAddedTaxOnInput', r.r5b),
    '  <!-- 5c: subtotaal -->',
    amount('ValueAddedTaxOwedToBePaidBack', r.r5a - r.r5b),
  ].join('\n');

  const contact = [
    '  <bd-i:ContactType contextRef="Msg">BPL</bd-i:ContactType>',
    `  <bd-i:ContactInitials contextRef="Msg">${escapedInitials}</bd-i:ContactInitials>`,
    `  <bd-i:ContactSurname contextRef="Msg">${escapedContactName}</bd-i:ContactSurname>`,
    ...(phone ? [`  <bd-i:ContactTelephoneNumber contextRef="Msg">${escapeXml(phone)}</bd-i:ContactTelephoneNumber>`] : []),
  ].join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<xbrli:xbrl
  xmlns:xbrli="http://www.xbrl.org/2003/instance"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:link="http://www.xbrl.org/2003/linkbase"
  xmlns:iso4217="http://www.xbrl.org/2003/iso4217"
  xmlns:bd-i="${taxonomy.dataNamespace}">

  <link:schemaRef
    xlink:type="simple"
    xlink:href="${taxonomy.obEntrypoint}" />

  <xbrli:context id="Msg">
    <xbrli:entity>
      <xbrli:identifier scheme="${OMZETBELASTINGNUMMER_SCHEME}">${escapedBtwNumber}</xbrli:identifier>
    </xbrli:entity>
    <xbrli:period>
      <xbrli:startDate>${periodStartDate}</xbrli:startDate>
      <xbrli:endDate>${periodEndDate}</xbrli:endDate>
    </xbrli:period>
  </xbrli:context>

  <xbrli:unit id="EUR">
    <xbrli:measure>iso4217:EUR</xbrli:measure>
  </xbrli:unit>

  <!-- Message details and contact -->
  <bd-i:DateTimeCreation contextRef="Msg">${now}</bd-i:DateTimeCreation>
  <bd-i:MessageReferenceSupplierVAT contextRef="Msg">${reference}</bd-i:MessageReferenceSupplierVAT>
  <bd-i:SoftwarePackageName contextRef="Msg">WeldSuite</bd-i:SoftwarePackageName>
  <bd-i:SoftwarePackageVersion contextRef="Msg">1.0</bd-i:SoftwarePackageVersion>
${contact}

${facts}

</xbrli:xbrl>`;
}
