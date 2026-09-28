/**
 * Generate SBR/XBRL XML for Dutch BTW-aangifte (OB aangifte).
 *
 * Produces a valid XBRL 2.1 instance document conforming to the
 * Dutch Belastingdienst SBR specification for omzetbelasting.
 */

export interface VatXmlInput {
  btwNumber: string; // e.g. "NL123456789B01"
  companyName: string;
  contactName: string;
  contactPhone: string;
  periodStart: string; // ISO date
  periodEnd: string; // ISO date
  rubrieken: {
    r1a: number;
    r1b: number;
    r1c: number;
    r1d: number;
    r1e: number;
    r1f: number;
    r2a: number;
    r3a: number;
    r3b: number;
    r3c: number;
    r4a: number;
    r4b: number;
    r5a: number;
    r5b: number;
    r5c: number;
    r5d: number;
    r5e: number;
    r5f: number;
  };
}

/**
 * Escape XML special characters in a string value.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Round a number to the nearest whole euro (as required by the Belastingdienst).
 */
function roundToWholeEuros(value: number): number {
  return Math.round(value);
}

/**
 * Generate a proper XBRL instance document for Dutch BTW-aangifte.
 *
 * The output follows the bd-ob (Belastingdienst Omzetbelasting) taxonomy
 * and uses standard XBRL 2.1 structure with:
 * - Namespaces for xbrli, iso4217, xlink, bd-ob, bd-bedr
 * - Context element with entity identifier (BTW number) and period
 * - Unit definitions for EUR and pure
 * - Facts for each rubriek mapped to the correct bd-ob element
 */
export function generateVatXml(input: VatXmlInput): string {
  const now = new Date().toISOString();
  const periodStartDate = input.periodStart.slice(0, 10);
  const periodEndDate = input.periodEnd.slice(0, 10);

  const r = input.rubrieken;

  // Round all values to whole euros for official filing
  const r1a = roundToWholeEuros(r.r1a);
  const r1b = roundToWholeEuros(r.r1b);
  const r1c = roundToWholeEuros(r.r1c);
  const r1d = roundToWholeEuros(r.r1d);
  const r1e = roundToWholeEuros(r.r1e);
  const r1f = roundToWholeEuros(r.r1f);
  const r2a = roundToWholeEuros(r.r2a);
  const r3a = roundToWholeEuros(r.r3a);
  const r3b = roundToWholeEuros(r.r3b);
  const r3c = roundToWholeEuros(r.r3c);
  const r4a = roundToWholeEuros(r.r4a);
  const r4b = roundToWholeEuros(r.r4b);
  const r5a = roundToWholeEuros(r.r5a);
  const r5b = roundToWholeEuros(r.r5b);
  const r5c = roundToWholeEuros(r.r5c);
  const r5d = roundToWholeEuros(r.r5d);
  const r5e = roundToWholeEuros(r.r5e);
  const r5f = roundToWholeEuros(r.r5f);

  const escapedCompanyName = escapeXml(input.companyName);
  const escapedContactName = escapeXml(input.contactName);
  const escapedContactPhone = escapeXml(input.contactPhone);
  const escapedBtwNumber = escapeXml(input.btwNumber);

  // Build the XBRL instance document
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xbrli:xbrl
  xmlns:xbrli="http://www.xbrl.org/2003/instance"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:link="http://www.xbrl.org/2003/linkbase"
  xmlns:iso4217="http://www.xbrl.org/2003/iso4217"
  xmlns:bd-ob="http://www.nltaxonomie.nl/nt17/bd/20231213/dictionary/bd-ob-tuples"
  xmlns:bd-bedr="http://www.nltaxonomie.nl/nt17/bd/20231213/dictionary/bd-bedr"
  xmlns:bd-dim-dim="http://www.nltaxonomie.nl/nt17/bd/20231213/dictionary/bd-dim-dim"
  xmlns:xbrldi="http://xbrl.org/2006/xbrldi">

  <!-- ================================================================== -->
  <!-- Schema References                                                   -->
  <!-- ================================================================== -->
  <link:schemaRef
    xlink:type="simple"
    xlink:href="http://www.nltaxonomie.nl/nt17/bd/20231213/entrypoints/bd-rpt-ob-aangifte-2024.xsd" />

  <!-- ================================================================== -->
  <!-- Context: Entity + Period                                            -->
  <!-- ================================================================== -->
  <xbrli:context id="ctx-period">
    <xbrli:entity>
      <xbrli:identifier scheme="http://www.belastingdienst.nl/omzetbelastingnummer">${escapedBtwNumber}</xbrli:identifier>
    </xbrli:entity>
    <xbrli:period>
      <xbrli:startDate>${periodStartDate}</xbrli:startDate>
      <xbrli:endDate>${periodEndDate}</xbrli:endDate>
    </xbrli:period>
  </xbrli:context>

  <xbrli:context id="ctx-instant">
    <xbrli:entity>
      <xbrli:identifier scheme="http://www.belastingdienst.nl/omzetbelastingnummer">${escapedBtwNumber}</xbrli:identifier>
    </xbrli:entity>
    <xbrli:period>
      <xbrli:instant>${periodEndDate}</xbrli:instant>
    </xbrli:period>
  </xbrli:context>

  <!-- ================================================================== -->
  <!-- Units                                                               -->
  <!-- ================================================================== -->
  <xbrli:unit id="u-eur">
    <xbrli:measure>iso4217:EUR</xbrli:measure>
  </xbrli:unit>

  <xbrli:unit id="u-pure">
    <xbrli:measure>xbrli:pure</xbrli:measure>
  </xbrli:unit>

  <!-- ================================================================== -->
  <!-- Contact / Filing metadata                                           -->
  <!-- ================================================================== -->
  <bd-bedr:ContactPerson contextRef="ctx-instant">${escapedContactName}</bd-bedr:ContactPerson>
  <bd-bedr:ContactTelephoneNumber contextRef="ctx-instant">${escapedContactPhone}</bd-bedr:ContactTelephoneNumber>
  <bd-bedr:EntityName contextRef="ctx-instant">${escapedCompanyName}</bd-bedr:EntityName>
  <bd-bedr:DateTimeCreation contextRef="ctx-instant">${now}</bd-bedr:DateTimeCreation>
  <bd-bedr:MessageReferenceSupplierVAT contextRef="ctx-instant">OB-${periodStartDate}-${periodEndDate}</bd-bedr:MessageReferenceSupplierVAT>
  <bd-bedr:SoftwarePackageName contextRef="ctx-instant">WeldSuite</bd-bedr:SoftwarePackageName>
  <bd-bedr:SoftwarePackageVersion contextRef="ctx-instant">1.0</bd-bedr:SoftwarePackageVersion>

  <!-- ================================================================== -->
  <!-- Rubriek 1: Binnenland (Domestic)                                    -->
  <!-- ================================================================== -->
  <!-- 1a: Leveringen/diensten belast met hoog tarief - omzet -->
  <bd-ob:TurnoverSuppliesServicesGeneralTariff contextRef="ctx-period" unitRef="u-eur" decimals="0">${r1a}</bd-ob:TurnoverSuppliesServicesGeneralTariff>
  <!-- 1b: Leveringen/diensten belast met hoog tarief - BTW -->
  <bd-ob:ValueAddedTaxSuppliesServicesGeneralTariff contextRef="ctx-period" unitRef="u-eur" decimals="0">${r1b}</bd-ob:ValueAddedTaxSuppliesServicesGeneralTariff>
  <!-- 1c: Leveringen/diensten belast met laag tarief - omzet -->
  <bd-ob:TurnoverSuppliesServicesReducedTariff contextRef="ctx-period" unitRef="u-eur" decimals="0">${r1c}</bd-ob:TurnoverSuppliesServicesReducedTariff>
  <!-- 1d: Leveringen/diensten belast met laag tarief - BTW -->
  <bd-ob:ValueAddedTaxSuppliesServicesReducedTariff contextRef="ctx-period" unitRef="u-eur" decimals="0">${r1d}</bd-ob:ValueAddedTaxSuppliesServicesReducedTariff>
  <!-- 1e: Leveringen/diensten belast met overige tarieven - omzet -->
  <bd-ob:TurnoverSuppliesServicesOtherRates contextRef="ctx-period" unitRef="u-eur" decimals="0">${r1e}</bd-ob:TurnoverSuppliesServicesOtherRates>
  <!-- 1f: Leveringen/diensten belast met overige tarieven - BTW -->
  <bd-ob:ValueAddedTaxSuppliesServicesOtherRates contextRef="ctx-period" unitRef="u-eur" decimals="0">${r1f}</bd-ob:ValueAddedTaxSuppliesServicesOtherRates>

  <!-- ================================================================== -->
  <!-- Rubriek 2: Verlegd (Reverse charge)                                 -->
  <!-- ================================================================== -->
  <!-- 2a: Leveringen/diensten waarbij omzetbelasting naar u is verlegd -->
  <bd-ob:TurnoverSuppliesServicesReverseCharge contextRef="ctx-period" unitRef="u-eur" decimals="0">${r2a}</bd-ob:TurnoverSuppliesServicesReverseCharge>

  <!-- ================================================================== -->
  <!-- Rubriek 3: Buitenland (Foreign)                                     -->
  <!-- ================================================================== -->
  <!-- 3a: Leveringen naar landen buiten de EU -->
  <bd-ob:TurnoverSuppliesServicesOutsideEU contextRef="ctx-period" unitRef="u-eur" decimals="0">${r3a}</bd-ob:TurnoverSuppliesServicesOutsideEU>
  <!-- 3b: Leveringen naar/diensten in landen binnen de EU -->
  <bd-ob:TurnoverSuppliesServicesWithinEU contextRef="ctx-period" unitRef="u-eur" decimals="0">${r3b}</bd-ob:TurnoverSuppliesServicesWithinEU>
  <!-- 3c: Installatie/afstandsverkopen binnen de EU -->
  <bd-ob:TurnoverInstallationDistanceSalesWithinEU contextRef="ctx-period" unitRef="u-eur" decimals="0">${r3c}</bd-ob:TurnoverInstallationDistanceSalesWithinEU>

  <!-- ================================================================== -->
  <!-- Rubriek 4: Uit het buitenland aan u verricht                        -->
  <!-- ================================================================== -->
  <!-- 4a: Leveringen/diensten uit landen buiten de EU -->
  <bd-ob:TurnoverFromOutsideEU contextRef="ctx-period" unitRef="u-eur" decimals="0">${r4a}</bd-ob:TurnoverFromOutsideEU>
  <!-- 4b: Leveringen/diensten uit landen binnen de EU -->
  <bd-ob:TurnoverFromWithinEU contextRef="ctx-period" unitRef="u-eur" decimals="0">${r4b}</bd-ob:TurnoverFromWithinEU>

  <!-- ================================================================== -->
  <!-- Rubriek 5: Berekening (Calculation)                                 -->
  <!-- ================================================================== -->
  <!-- 5a: Verschuldigde omzetbelasting (subtotaal) -->
  <bd-ob:ValueAddedTaxOwed contextRef="ctx-period" unitRef="u-eur" decimals="0">${r5a}</bd-ob:ValueAddedTaxOwed>
  <!-- 5b: Voorbelasting -->
  <bd-ob:ValueAddedTaxOnInput contextRef="ctx-period" unitRef="u-eur" decimals="0">${r5b}</bd-ob:ValueAddedTaxOnInput>
  <!-- 5c: Subtotaal -->
  <bd-ob:ValueAddedTaxOwedToBePaidBack contextRef="ctx-period" unitRef="u-eur" decimals="0">${r5c}</bd-ob:ValueAddedTaxOwedToBePaidBack>
  <!-- 5d: Vermindering volgens kleineondernemersregeling -->
  <bd-ob:ValueAddedTaxSmallEntrepreneurProvisionReduction contextRef="ctx-period" unitRef="u-eur" decimals="0">${r5d}</bd-ob:ValueAddedTaxSmallEntrepreneurProvisionReduction>
  <!-- 5e: Schatting vorige aangifte(n) -->
  <bd-ob:ValueAddedTaxEstimatePreviousReturns contextRef="ctx-period" unitRef="u-eur" decimals="0">${r5e}</bd-ob:ValueAddedTaxEstimatePreviousReturns>
  <!-- 5f: Totaal te betalen / terug te ontvangen -->
  <bd-ob:ValueAddedTaxOwedToBePaidBackTotalAmount contextRef="ctx-period" unitRef="u-eur" decimals="0">${r5f}</bd-ob:ValueAddedTaxOwedToBePaidBackTotalAmount>

</xbrli:xbrl>`;

  return xml;
}
