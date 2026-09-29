/**
 * Generate SBR/XBRL XML for the Dutch Opgaaf ICP
 * (intracommunautaire prestaties).
 *
 * Structured after the bd-icp (Belastingdienst Opgaaf ICP) taxonomy: one
 * duration context for the declaration period plus, per counterparty VAT
 * number, the net supplies split by goods / services / triangulation.
 *
 * NOTE: validate against the current Nederlandse Taxonomie (NT) ICP entry
 * point before switching DIGIPOORT_MODE to production — element names are
 * revised with each NT release. Filing stays simulated until the
 * PKIoverheid certificate is provisioned, so there is no live exposure.
 */

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
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Whole euros, as required for SBR filings. */
function roundToWholeEuros(value: number): number {
  return Math.round(value);
}

function supplyElement(type: IcpXmlLine['supplyType']): string {
  switch (type) {
    case 'services':
      return 'IntraCommunitySuppliesServicesAmount';
    case 'triangulation':
      return 'IntraCommunitySuppliesABCTransactionsAmount';
    default:
      return 'IntraCommunitySuppliesGoodsAmount';
  }
}

export function generateIcpXml(input: IcpXmlInput): string {
  const periodStart = input.periodStart.slice(0, 10);
  const periodEnd = input.periodEnd.slice(0, 10);

  const contexts = input.lines
    .map(
      (line, idx) => `
  <xbrli:context id="Line${idx + 1}">
    <xbrli:entity>
      <xbrli:identifier scheme="www.belastingdienst.nl/omzetbelastingnummer">${escapeXml(input.btwNumber)}</xbrli:identifier>
    </xbrli:entity>
    <xbrli:period>
      <xbrli:startDate>${periodStart}</xbrli:startDate>
      <xbrli:endDate>${periodEnd}</xbrli:endDate>
    </xbrli:period>
    <xbrli:scenario>
      <bd-icp-dim:CounterPartyVatIdentificationNumber>${escapeXml(line.vatNumber)}</bd-icp-dim:CounterPartyVatIdentificationNumber>
      <bd-icp-dim:CountryCode>${escapeXml(line.countryCode)}</bd-icp-dim:CountryCode>
    </xbrli:scenario>
  </xbrli:context>`,
    )
    .join('');

  const facts = input.lines
    .map(
      (line, idx) =>
        `
  <bd-icp:${supplyElement(line.supplyType)} contextRef="Line${idx + 1}" unitRef="EUR" decimals="INF">${roundToWholeEuros(line.amount)}</bd-icp:${supplyElement(line.supplyType)}>`,
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<xbrli:xbrl
  xmlns:xbrli="http://www.xbrl.org/2003/instance"
  xmlns:link="http://www.xbrl.org/2003/linkbase"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:iso4217="http://www.xbrl.org/2003/iso4217"
  xmlns:bd-icp="http://www.nltaxonomie.nl/nt17/bd/20221207/dictionary/bd-data"
  xmlns:bd-icp-dim="http://www.nltaxonomie.nl/nt17/bd/20221207/dictionary/bd-axes">
  <link:schemaRef xlink:type="simple" xlink:href="http://www.nltaxonomie.nl/nt17/bd/20221207/entrypoints/bd-rpt-icp-opgaaf-2023.xsd"/>
  <xbrli:context id="Period">
    <xbrli:entity>
      <xbrli:identifier scheme="www.belastingdienst.nl/omzetbelastingnummer">${escapeXml(input.btwNumber)}</xbrli:identifier>
    </xbrli:entity>
    <xbrli:period>
      <xbrli:startDate>${periodStart}</xbrli:startDate>
      <xbrli:endDate>${periodEnd}</xbrli:endDate>
    </xbrli:period>
  </xbrli:context>${contexts}
  <xbrli:unit id="EUR">
    <xbrli:measure>iso4217:EUR</xbrli:measure>
  </xbrli:unit>${facts}
</xbrli:xbrl>`;
}
