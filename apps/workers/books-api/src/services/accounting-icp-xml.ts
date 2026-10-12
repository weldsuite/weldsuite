/**
 * Generate SBR/XBRL XML for the Dutch Opgaaf ICP
 * (intracommunautaire prestaties).
 *
 * Follows the `bd-rpt-icp-opgaaf` entrypoint of the period's year (see
 * `jurisdictions/nl/taxonomy.ts`), checked against NT20: one context per
 * counterparty, carrying the typed dimensions `CountryCodeEUDimension` and
 * `VATNumberDimension` (the VAT number without its country prefix), with up to
 * three facts on it:
 *
 *   goods (leveringen)            bd-i:SuppliesAmount
 *   services (diensten)           bd-i:ServicesAmount
 *   ABC / triangulation           bd-i:ABCSuppliesAmount
 *
 * Filing stays simulated until the PKIoverheid certificate is provisioned
 * (see accounting-digipoort.ts), so there is no live exposure; re-check the
 * element names against the NT release of the filing year before switching
 * DIGIPOORT_MODE to production.
 */

import { nlTaxonomyUris } from '@weldsuite/books-domain/jurisdictions/nl';

export interface IcpXmlLine {
  vatNumber: string; // full, e.g. DE123456789
  countryCode: string;
  supplyType: 'goods' | 'services' | 'triangulation';
  amount: number;
}

export interface IcpXmlInput {
  btwNumber: string; // e.g. "NL123456789B01"
  companyName: string;
  periodStart: string; // ISO date
  periodEnd: string; // ISO date
  lines: IcpXmlLine[];
  contactName?: string;
  contactPhone?: string;
  /** Unique reference of this message (MessageReferenceSupplierVAT). Defaults to `ICP-<start>-<end>`. */
  messageReference?: string;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&apos;');
}

/** Whole euros, as required for SBR filings. */
function roundToWholeEuros(value: number): number {
  return Math.round(value) || 0;
}

/** The fact element of a supply type (prefix `bd-i`). */
export function icpSupplyElement(type: IcpXmlLine['supplyType']): string {
  switch (type) {
    case 'services':
      return 'ServicesAmount';
    case 'triangulation':
      return 'ABCSuppliesAmount';
    default:
      return 'SuppliesAmount';
  }
}

const OMZETBELASTINGNUMMER_SCHEME = 'http://www.belastingdienst.nl/omzetbelastingnummer';

function initialsOf(name: string): string {
  const letters = name
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}]/gu, '')[0])
    .filter(Boolean)
    .join('')
    .toUpperCase();
  return (letters || 'X').slice(0, 10);
}

export function generateIcpXml(input: IcpXmlInput): string {
  const periodStart = input.periodStart.slice(0, 10);
  const periodEnd = input.periodEnd.slice(0, 10);
  const taxonomy = nlTaxonomyUris(periodStart);
  const btwNumber = escapeXml(input.btwNumber);

  // One context per counterparty: its goods, services and ABC amounts share it.
  const perCounterparty = new Map<string, { vatNumber: string; countryCode: string; amounts: Map<IcpXmlLine['supplyType'], number> }>();
  for (const line of input.lines) {
    const key = line.vatNumber;
    const entry = perCounterparty.get(key) ?? { vatNumber: line.vatNumber, countryCode: line.countryCode, amounts: new Map() };
    entry.amounts.set(line.supplyType, (entry.amounts.get(line.supplyType) ?? 0) + line.amount);
    perCounterparty.set(key, entry);
  }

  const contexts: string[] = [];
  const facts: string[] = [];
  let idx = 0;
  for (const entry of perCounterparty.values()) {
    idx += 1;
    const id = `Line${idx}`;
    const country = entry.countryCode.toUpperCase();
    // The typed VAT number domain holds the number without its country prefix.
    const number = entry.vatNumber.toUpperCase().startsWith(country) ? entry.vatNumber.slice(country.length) : entry.vatNumber;
    contexts.push(`
  <xbrli:context id="${id}">
    <xbrli:entity>
      <xbrli:identifier scheme="${OMZETBELASTINGNUMMER_SCHEME}">${btwNumber}</xbrli:identifier>
    </xbrli:entity>
    <xbrli:period>
      <xbrli:startDate>${periodStart}</xbrli:startDate>
      <xbrli:endDate>${periodEnd}</xbrli:endDate>
    </xbrli:period>
    <xbrli:scenario>
      <xbrldi:typedMember dimension="bd-dim-dim:CountryCodeEUDimension">
        <bd-dim-dom:CountryCodeEUDomain>${escapeXml(country)}</bd-dim-dom:CountryCodeEUDomain>
      </xbrldi:typedMember>
      <xbrldi:typedMember dimension="bd-dim-dim:VATNumberDimension">
        <bd-dim-dom:VATNumberDomain>${escapeXml(number)}</bd-dim-dom:VATNumberDomain>
      </xbrldi:typedMember>
    </xbrli:scenario>
  </xbrli:context>`);
    for (const type of ['goods', 'services', 'triangulation'] as const) {
      const amount = entry.amounts.get(type);
      if (amount === undefined) continue;
      const element = icpSupplyElement(type);
      facts.push(`  <bd-i:${element} contextRef="${id}" unitRef="EUR" decimals="0">${roundToWholeEuros(amount)}</bd-i:${element}>`);
    }
  }

  const contactName = input.contactName ?? input.companyName;
  const phone = (input.contactPhone ?? '').replace(/[^\d+]/g, '').slice(0, 14);
  const reference = escapeXml((input.messageReference ?? `ICP-${periodStart}-${periodEnd}`).slice(0, 200));

  return `<?xml version="1.0" encoding="UTF-8"?>
<xbrli:xbrl
  xmlns:xbrli="http://www.xbrl.org/2003/instance"
  xmlns:link="http://www.xbrl.org/2003/linkbase"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:iso4217="http://www.xbrl.org/2003/iso4217"
  xmlns:xbrldi="http://xbrl.org/2006/xbrldi"
  xmlns:bd-i="${taxonomy.dataNamespace}"
  xmlns:bd-dim-dim="${taxonomy.axesNamespace}"
  xmlns:bd-dim-dom="${taxonomy.domainsNamespace}">
  <link:schemaRef xlink:type="simple" xlink:href="${taxonomy.icpEntrypoint}"/>
  <xbrli:context id="Msg">
    <xbrli:entity>
      <xbrli:identifier scheme="${OMZETBELASTINGNUMMER_SCHEME}">${btwNumber}</xbrli:identifier>
    </xbrli:entity>
    <xbrli:period>
      <xbrli:startDate>${periodStart}</xbrli:startDate>
      <xbrli:endDate>${periodEnd}</xbrli:endDate>
    </xbrli:period>
  </xbrli:context>${contexts.join('')}
  <xbrli:unit id="EUR">
    <xbrli:measure>iso4217:EUR</xbrli:measure>
  </xbrli:unit>
  <bd-i:DateTimeCreation contextRef="Msg">${new Date().toISOString()}</bd-i:DateTimeCreation>
  <bd-i:MessageReferenceSupplierVAT contextRef="Msg">${reference}</bd-i:MessageReferenceSupplierVAT>
  <bd-i:SoftwarePackageName contextRef="Msg">WeldSuite</bd-i:SoftwarePackageName>
  <bd-i:SoftwarePackageVersion contextRef="Msg">1.0</bd-i:SoftwarePackageVersion>
  <bd-i:ContactType contextRef="Msg">BPL</bd-i:ContactType>
  <bd-i:ContactInitials contextRef="Msg">${escapeXml(initialsOf(contactName))}</bd-i:ContactInitials>
  <bd-i:ContactSurname contextRef="Msg">${escapeXml(contactName.slice(0, 200))}</bd-i:ContactSurname>${phone ? `\n  <bd-i:ContactTelephoneNumber contextRef="Msg">${escapeXml(phone)}</bd-i:ContactTelephoneNumber>` : ''}
${facts.join('\n')}
</xbrli:xbrl>`;
}
