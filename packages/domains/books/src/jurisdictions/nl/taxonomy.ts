/**
 * Nederlandse Taxonomie (NT) versions used for the SBR/XBRL filings of the
 * Belastingdienst (OB aangifte, Opgaaf ICP).
 *
 * Every year a new NT is released in December and holds the entrypoints for
 * the NEXT reporting year, e.g. NT20 / `bd/20251210` has
 * `bd-rpt-ob-aangifte-2026.xsd` and `bd-rpt-icp-opgaaf-2026.xsd`. Digipoort
 * accepts the entrypoint of the period's year, so the version is picked by the
 * period's (start) year. To support a new year, add one row here; nothing else
 * in the XML generators names a taxonomy version.
 *
 * Checked against https://www.nltaxonomie.nl/ (directory listings of
 * nt17 .. nt21): the entrypoint files exist for each row below.
 */
export interface NlTaxonomyVersion {
  /** The reporting year the entrypoints are for (`...-<year>.xsd`). */
  year: number;
  /** NT release, e.g. 'nt20'. */
  nt: string;
  /** Release folder of the Belastingdienst (bd) part of that NT. */
  release: string;
  /**
   * The release is not final yet (a `.a` / `.b` pre-release folder). Check
   * https://www.nltaxonomie.nl/ before filing a period of that year.
   */
  provisional?: boolean;
}

/**
 * Only NT20 onwards: from NT20 the OB and ICP messages use the element and
 * dimension names generated here (bd-data / bd-axes `VATNumberDimension`,
 * `CountryCodeEUDimension`); NT17-NT19 laid the ICP out differently, so older
 * periods are not rendered with their own version (they fall back to the
 * oldest row below).
 */
export const NL_TAXONOMY_VERSIONS: readonly NlTaxonomyVersion[] = [
  { year: 2026, nt: 'nt20', release: '20251210' },
  // NT21 final (20261209) is not published yet: this is its latest pre-release.
  { year: 2027, nt: 'nt21', release: '20261209.b', provisional: true },
];

const BASE = 'http://www.nltaxonomie.nl';

/** The taxonomy version for the reporting year of a period; the newest known version for later years, the oldest for earlier ones. */
export function nlTaxonomyForPeriod(periodStart: string | Date): NlTaxonomyVersion {
  const year = typeof periodStart === 'string' ? Number(periodStart.slice(0, 4)) : periodStart.getUTCFullYear();
  const versions = NL_TAXONOMY_VERSIONS;
  const exact = versions.find((v) => v.year === year);
  if (exact) return exact;
  return year > versions[versions.length - 1].year ? versions[versions.length - 1] : versions[0];
}

export interface NlTaxonomyUris {
  version: NlTaxonomyVersion;
  /** schemaRef of the OB aangifte (VAT return). */
  obEntrypoint: string;
  /** schemaRef of the Opgaaf ICP. */
  icpEntrypoint: string;
  /** Namespace of the data dictionary (prefix `bd-i`). */
  dataNamespace: string;
  /** Namespace of the dimensions (prefix `bd-dim-dim`). */
  axesNamespace: string;
  /** Namespace of the typed dimension domains (prefix `bd-dim-dom`). */
  domainsNamespace: string;
}

export function nlTaxonomyUris(periodStart: string | Date): NlTaxonomyUris {
  const version = nlTaxonomyForPeriod(periodStart);
  const root = `${BASE}/${version.nt}/bd/${version.release}`;
  return {
    version,
    obEntrypoint: `${root}/entrypoints/bd-rpt-ob-aangifte-${version.year}.xsd`,
    icpEntrypoint: `${root}/entrypoints/bd-rpt-icp-opgaaf-${version.year}.xsd`,
    dataNamespace: `${root}/dictionary/bd-data`,
    axesNamespace: `${root}/validation/bd-axes`,
    domainsNamespace: `${root}/validation/bd-domains`,
  };
}
