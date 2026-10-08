/**
 * US states (plus DC) as sales tax jurisdictions, and the territories for
 * addresses.
 *
 * Sources: docs/plans/weldbooks-us-research/sales-tax.md (§4.2 sourcing,
 * §7 rounding and reporting basis, §8 due dates). Due days and vendor
 * discounts are data the Sales Tax Center reads; check them against the
 * state's revenue department before relying on them for a filing (the
 * research could not re-verify every one for 2026, see §12).
 */

export type UsStateCode =
  | 'AL' | 'AK' | 'AZ' | 'AR' | 'CA' | 'CO' | 'CT' | 'DE' | 'DC' | 'FL'
  | 'GA' | 'HI' | 'ID' | 'IL' | 'IN' | 'IA' | 'KS' | 'KY' | 'LA' | 'ME'
  | 'MD' | 'MA' | 'MI' | 'MN' | 'MS' | 'MO' | 'MT' | 'NE' | 'NV' | 'NH'
  | 'NJ' | 'NM' | 'NY' | 'NC' | 'ND' | 'OH' | 'OK' | 'OR' | 'PA' | 'RI'
  | 'SC' | 'SD' | 'TN' | 'TX' | 'UT' | 'VT' | 'VA' | 'WA' | 'WV' | 'WI'
  | 'WY';

export type UsTerritoryCode = 'AS' | 'GU' | 'MP' | 'PR' | 'VI';

/**
 * Intrastate sourcing: `origin` taxes a sale at the seller's location,
 * `destination` at the ship-to address. `modified_origin` (California):
 * state, county and city tax at origin, district taxes at destination.
 * Interstate sales are destination-sourced everywhere.
 */
export type IntrastateSourcing = 'origin' | 'modified_origin' | 'destination';

export interface SalesTaxRounding {
  /** Round per line or once per document (per jurisdiction). SST lets the seller choose; invoice is the default. */
  level: 'line' | 'invoice';
  /** Round each jurisdiction's tax, or the combined rate's tax. */
  scope: 'per_jurisdiction' | 'combined';
}

export interface VendorDiscountRule {
  /** Percent of the tax due kept for timely filing and payment. */
  percent: number;
  /** Cap per return, in dollars. */
  capPerReturn?: number;
  /** Tiered rules (e.g. Georgia 3% on the first $3,000, 0.5% above). */
  tiers?: Array<{ upTo: number | null; percent: number }>;
  note?: string;
}

/**
 * When a certificate without an explicit expiry date stops being valid.
 * `calendar_year_end`: 31 December of the issue year. `months_from_issue`: that
 * many months after the issue date. `months_from_last_purchase`: valid while
 * the buyer buys at least this often (SST blanket certificates).
 */
export type CertificateExpiryRule =
  | { kind: 'calendar_year_end' }
  | { kind: 'months_from_issue'; months: number }
  | { kind: 'months_from_last_purchase'; months: number };

export interface CertificateValidityRule {
  /** Exempt reasons the rule covers; every reason when omitted. */
  reasons?: string[];
  /** Certificate forms the rule covers (`state_form`, `sst_f0003`, ...); every form when omitted. */
  forms?: string[];
  blanketOnly?: boolean;
  expiry: CertificateExpiryRule;
  note?: string;
}

export interface UsStateInfo {
  code: UsStateCode;
  name: string;
  /** Two-digit FIPS state code. */
  fips: string;
  /** A state-level sales (or gross receipts / excise) tax exists. */
  hasStateSalesTax: boolean;
  /** Local sales taxes exist (Alaska has local taxes only). */
  hasLocalSalesTax: boolean;
  intrastateSourcing: IntrastateSourcing;
  /** Streamlined Sales Tax: full member, associate (Tennessee) or none. */
  sst: 'full' | 'associate' | 'none';
  /** The agency that administers the state tax (or the remote-seller commission). */
  agencyName: string | null;
  portalUrl: string | null;
  rounding: SalesTaxRounding;
  /** The state lets a seller report on a cash basis (otherwise accrual only). */
  cashBasisAllowed: boolean;
  /** Day of the month after the period the return is due; `last` = last day of that month. */
  defaultDueDay: number | 'last';
  vendorDiscount?: VendorDiscountRule;
  /** State-specific programs the setup screen points out. */
  specialPrograms?: Array<
    | 'al_simplified_sellers_use_tax'
    | 'tx_single_local_use_rate'
    | 'co_suts'
    | 'la_remote_sellers_commission'
    | 'ak_arsstc'
    | 'home_rule_local_agencies'
  >;
  /** Name of the tax when it isn't called sales tax. */
  taxName?: string;
  /**
   * Validity rules for certificates that carry no expiry date, on top of the
   * SST blanket rule every SST state gets (see `getCertificateRules`). A
   * certificate's own `expiresOn` always wins.
   */
  certificateRules?: CertificateValidityRule[];
}

const SST_INVOICE: SalesTaxRounding = { level: 'invoice', scope: 'per_jurisdiction' };

function state(
  code: UsStateCode,
  name: string,
  fips: string,
  opts: Partial<Omit<UsStateInfo, 'code' | 'name' | 'fips'>> = {},
): UsStateInfo {
  return {
    code,
    name,
    fips,
    hasStateSalesTax: true,
    hasLocalSalesTax: true,
    intrastateSourcing: 'destination',
    sst: 'none',
    agencyName: `${name} Department of Revenue`,
    portalUrl: null,
    rounding: SST_INVOICE,
    cashBasisAllowed: false,
    defaultDueDay: 20,
    ...opts,
  };
}

export const US_STATES: readonly UsStateInfo[] = [
  state('AL', 'Alabama', '01', {
    portalUrl: 'https://myalabamataxes.alabama.gov',
    specialPrograms: ['al_simplified_sellers_use_tax', 'home_rule_local_agencies'],
  }),
  state('AK', 'Alaska', '02', {
    hasStateSalesTax: false,
    agencyName: 'Alaska Remote Seller Sales Tax Commission',
    portalUrl: 'https://arsstc.org',
    defaultDueDay: 'last',
    specialPrograms: ['ak_arsstc', 'home_rule_local_agencies'],
  }),
  state('AZ', 'Arizona', '04', {
    intrastateSourcing: 'origin',
    portalUrl: 'https://azdor.gov',
    cashBasisAllowed: true,
    taxName: 'Transaction privilege tax',
  }),
  state('AR', 'Arkansas', '05', {
    sst: 'full',
    agencyName: 'Arkansas Department of Finance and Administration',
    portalUrl: 'https://atap.arkansas.gov',
  }),
  state('CA', 'California', '06', {
    intrastateSourcing: 'modified_origin',
    agencyName: 'California Department of Tax and Fee Administration',
    portalUrl: 'https://onlineservices.cdtfa.ca.gov',
    defaultDueDay: 'last',
  }),
  state('CO', 'Colorado', '08', {
    portalUrl: 'https://mytaxes.colorado.gov',
    specialPrograms: ['co_suts', 'home_rule_local_agencies'],
  }),
  state('CT', 'Connecticut', '09', {
    hasLocalSalesTax: false,
    agencyName: 'Connecticut Department of Revenue Services',
    portalUrl: 'https://drs.ct.gov',
    defaultDueDay: 'last',
  }),
  state('DE', 'Delaware', '10', {
    hasStateSalesTax: false,
    hasLocalSalesTax: false,
    agencyName: null,
  }),
  state('DC', 'District of Columbia', '11', {
    hasLocalSalesTax: false,
    agencyName: 'DC Office of Tax and Revenue',
    portalUrl: 'https://mytax.dc.gov',
  }),
  state('FL', 'Florida', '12', {
    portalUrl: 'https://floridarevenue.com',
    vendorDiscount: { percent: 2.5, capPerReturn: 30, note: '2.5% of the first $1,200 of tax per return; e-filed and paid on time' },
    certificateRules: [
      {
        reasons: ['resale'],
        forms: ['state_form', 'other'],
        expiry: { kind: 'calendar_year_end' },
        note: 'The annual resale certificate (DR-13) expires every 31 December',
      },
    ],
  }),
  state('GA', 'Georgia', '13', {
    sst: 'full',
    portalUrl: 'https://gtc.dor.ga.gov',
    cashBasisAllowed: true,
    vendorDiscount: {
      percent: 3,
      tiers: [{ upTo: 3000, percent: 3 }, { upTo: null, percent: 0.5 }],
      note: '3% of the first $3,000 of tax, 0.5% above; filed and paid on time',
    },
  }),
  state('HI', 'Hawaii', '15', {
    hasLocalSalesTax: true,
    agencyName: 'Hawaii Department of Taxation',
    portalUrl: 'https://hitax.hawaii.gov',
    cashBasisAllowed: true,
    taxName: 'General excise tax',
  }),
  state('ID', 'Idaho', '16', {
    agencyName: 'Idaho State Tax Commission',
    portalUrl: 'https://tap.tax.idaho.gov',
  }),
  state('IL', 'Illinois', '17', {
    intrastateSourcing: 'origin',
    portalUrl: 'https://mytax.illinois.gov',
    vendorDiscount: { percent: 1.75, note: '1.75% of tax due, capped monthly since 2025' },
  }),
  state('IN', 'Indiana', '18', {
    hasLocalSalesTax: false,
    sst: 'full',
    portalUrl: 'https://intime.dor.in.gov',
  }),
  state('IA', 'Iowa', '19', {
    sst: 'full',
    portalUrl: 'https://govconnect.iowa.gov',
    defaultDueDay: 'last',
  }),
  state('KS', 'Kansas', '20', {
    sst: 'full',
    portalUrl: 'https://www.kdor.ks.gov',
    defaultDueDay: 25,
  }),
  state('KY', 'Kentucky', '21', {
    hasLocalSalesTax: false,
    sst: 'full',
    portalUrl: 'https://revenue.ky.gov',
  }),
  state('LA', 'Louisiana', '22', {
    portalUrl: 'https://latap.revenue.louisiana.gov',
    specialPrograms: ['la_remote_sellers_commission', 'home_rule_local_agencies'],
  }),
  state('ME', 'Maine', '23', {
    hasLocalSalesTax: false,
    agencyName: 'Maine Revenue Services',
    portalUrl: 'https://revenue.maine.gov',
    defaultDueDay: 15,
  }),
  state('MD', 'Maryland', '24', {
    hasLocalSalesTax: false,
    agencyName: 'Comptroller of Maryland',
    portalUrl: 'https://interactive.marylandtaxes.gov',
  }),
  state('MA', 'Massachusetts', '25', {
    hasLocalSalesTax: false,
    portalUrl: 'https://mtc.dor.state.ma.us',
  }),
  state('MI', 'Michigan', '26', {
    hasLocalSalesTax: false,
    sst: 'full',
    agencyName: 'Michigan Department of Treasury',
    portalUrl: 'https://mto.treasury.michigan.gov',
  }),
  state('MN', 'Minnesota', '27', {
    sst: 'full',
    portalUrl: 'https://www.mndor.state.mn.us/tp/eservices',
  }),
  state('MS', 'Mississippi', '28', {
    intrastateSourcing: 'origin',
    portalUrl: 'https://tap.dor.ms.gov',
  }),
  state('MO', 'Missouri', '29', {
    intrastateSourcing: 'origin',
    portalUrl: 'https://mytax.mo.gov',
  }),
  state('MT', 'Montana', '30', {
    hasStateSalesTax: false,
    hasLocalSalesTax: false,
    agencyName: null,
  }),
  state('NE', 'Nebraska', '31', {
    sst: 'full',
    portalUrl: 'https://revenue.nebraska.gov',
  }),
  state('NV', 'Nevada', '32', {
    sst: 'full',
    agencyName: 'Nevada Department of Taxation',
    portalUrl: 'https://www.nevadatax.nv.gov',
    defaultDueDay: 'last',
  }),
  state('NH', 'New Hampshire', '33', {
    hasStateSalesTax: false,
    hasLocalSalesTax: false,
    agencyName: null,
  }),
  state('NJ', 'New Jersey', '34', {
    hasLocalSalesTax: false,
    sst: 'full',
    agencyName: 'New Jersey Division of Taxation',
    portalUrl: 'https://www.njportal.com/taxation',
  }),
  state('NM', 'New Mexico', '35', {
    agencyName: 'New Mexico Taxation and Revenue Department',
    portalUrl: 'https://tap.state.nm.us',
    cashBasisAllowed: true,
    defaultDueDay: 25,
    taxName: 'Gross receipts tax',
  }),
  state('NY', 'New York', '36', {
    agencyName: 'New York State Department of Taxation and Finance',
    portalUrl: 'https://www.tax.ny.gov',
    vendorDiscount: { percent: 5, capPerReturn: 200, note: '5% vendor collection credit, capped per quarterly return' },
  }),
  state('NC', 'North Carolina', '37', {
    sst: 'full',
    portalUrl: 'https://www.ncdor.gov',
  }),
  state('ND', 'North Dakota', '38', {
    sst: 'full',
    agencyName: 'North Dakota Office of State Tax Commissioner',
    portalUrl: 'https://apps.nd.gov/tax/tap',
    defaultDueDay: 'last',
  }),
  state('OH', 'Ohio', '39', {
    intrastateSourcing: 'origin',
    sst: 'full',
    agencyName: 'Ohio Department of Taxation',
    portalUrl: 'https://tax.ohio.gov',
    defaultDueDay: 23,
  }),
  state('OK', 'Oklahoma', '40', {
    sst: 'full',
    agencyName: 'Oklahoma Tax Commission',
    portalUrl: 'https://oktap.tax.ok.gov',
  }),
  state('OR', 'Oregon', '41', {
    hasStateSalesTax: false,
    hasLocalSalesTax: false,
    agencyName: null,
  }),
  state('PA', 'Pennsylvania', '42', {
    portalUrl: 'https://mypath.pa.gov',
    vendorDiscount: { percent: 1, capPerReturn: 25, note: '1% of tax, capped at $25 per monthly return' },
  }),
  state('RI', 'Rhode Island', '44', {
    hasLocalSalesTax: false,
    sst: 'full',
    agencyName: 'Rhode Island Division of Taxation',
    portalUrl: 'https://taxportal.ri.gov',
  }),
  state('SC', 'South Carolina', '45', {
    portalUrl: 'https://mydorway.dor.sc.gov',
  }),
  state('SD', 'South Dakota', '46', {
    sst: 'full',
    portalUrl: 'https://apps.sd.gov/rv23epath',
  }),
  state('TN', 'Tennessee', '47', {
    intrastateSourcing: 'origin',
    sst: 'associate',
    portalUrl: 'https://tntap.tn.gov',
  }),
  state('TX', 'Texas', '48', {
    intrastateSourcing: 'origin',
    agencyName: 'Texas Comptroller of Public Accounts',
    portalUrl: 'https://comptroller.texas.gov/taxes/sales',
    vendorDiscount: { percent: 0.5, note: '0.5% for timely filing, plus 1.25% for prepayment' },
    specialPrograms: ['tx_single_local_use_rate'],
  }),
  state('UT', 'Utah', '49', {
    intrastateSourcing: 'origin',
    sst: 'full',
    agencyName: 'Utah State Tax Commission',
    portalUrl: 'https://tap.tax.utah.gov',
    defaultDueDay: 'last',
  }),
  state('VT', 'Vermont', '50', {
    sst: 'full',
    agencyName: 'Vermont Department of Taxes',
    portalUrl: 'https://myvtax.vermont.gov',
    defaultDueDay: 25,
  }),
  state('VA', 'Virginia', '51', {
    intrastateSourcing: 'origin',
    agencyName: 'Virginia Department of Taxation',
    portalUrl: 'https://www.tax.virginia.gov',
  }),
  state('WA', 'Washington', '53', {
    sst: 'full',
    agencyName: 'Washington State Department of Revenue',
    portalUrl: 'https://secure.dor.wa.gov',
    cashBasisAllowed: true,
    defaultDueDay: 25,
    certificateRules: [
      {
        reasons: ['resale'],
        forms: ['state_form', 'other'],
        expiry: { kind: 'months_from_issue', months: 48 },
        note: 'A reseller permit is valid 48 months (24 for contractors and new businesses; enter the expiry date for those)',
      },
    ],
  }),
  state('WV', 'West Virginia', '54', {
    sst: 'full',
    agencyName: 'West Virginia Tax Division',
    portalUrl: 'https://mytaxes.wvtax.gov',
  }),
  state('WI', 'Wisconsin', '55', {
    sst: 'full',
    portalUrl: 'https://tap.revenue.wi.gov',
    defaultDueDay: 'last',
  }),
  state('WY', 'Wyoming', '56', {
    sst: 'full',
    portalUrl: 'https://excise-wyifs.wy.gov',
    defaultDueDay: 'last',
  }),
];

export const US_TERRITORIES: ReadonlyArray<{ code: UsTerritoryCode; name: string; fips: string }> = [
  { code: 'AS', name: 'American Samoa', fips: '60' },
  { code: 'GU', name: 'Guam', fips: '66' },
  { code: 'MP', name: 'Northern Mariana Islands', fips: '69' },
  { code: 'PR', name: 'Puerto Rico', fips: '72' },
  { code: 'VI', name: 'U.S. Virgin Islands', fips: '78' },
];

const BY_CODE = new Map(US_STATES.map((s) => [s.code, s]));

export function getUsState(code: string | null | undefined): UsStateInfo | undefined {
  if (!code) return undefined;
  return BY_CODE.get(code.trim().toUpperCase() as UsStateCode);
}

export function isUsStateCode(code: string | null | undefined): code is UsStateCode {
  return Boolean(getUsState(code));
}

/** A state or territory code a US address may carry. */
export function isUsAddressStateCode(code: string | null | undefined): boolean {
  if (!code) return false;
  const upper = code.trim().toUpperCase();
  return BY_CODE.has(upper as UsStateCode) || US_TERRITORIES.some((t) => t.code === upper);
}

/** States that levy a sales tax a seller can register for (state or local). */
export function salesTaxStates(): UsStateInfo[] {
  return US_STATES.filter((s) => s.hasStateSalesTax || s.hasLocalSalesTax);
}

/** SST blanket certificates (form F0003) stay valid while purchases are at most 12 months apart. */
const SST_BLANKET_RULE: CertificateValidityRule = {
  forms: ['sst_f0003'],
  blanketOnly: true,
  expiry: { kind: 'months_from_last_purchase', months: 12 },
  note: 'An SST blanket certificate is valid while purchases are no more than 12 months apart',
};

/** The state's own certificate rules plus the SST blanket rule for SST members. */
export function getCertificateRules(code: string | null | undefined): CertificateValidityRule[] {
  const info = getUsState(code);
  if (!info) return [];
  const rules = info.certificateRules ?? [];
  return info.sst === 'none' ? rules : [...rules, SST_BLANKET_RULE];
}

export type ShippingTaxability = 'taxable' | 'exempt_if_separate' | 'follows_goods';

/**
 * How a state treats a separately stated delivery charge (research
 * sales-tax.md §5.3). Seeds the taxability rules of a new agency; the engines
 * read the agency's rules, not this table. Confirm against the state's
 * guidance before relying on it.
 */
const SHIPPING_TAXABLE_STATES = new Set([
  'AR', 'CT', 'GA', 'IN', 'KY', 'LA', 'MN', 'NJ', 'NY', 'NC', 'OH', 'PA', 'TN', 'TX', 'WA', 'WI',
]);
const SHIPPING_EXEMPT_STATES = new Set(['AZ', 'IA', 'KS', 'MD', 'MI', 'MO', 'NV', 'OK', 'UT', 'VA']);

export function shippingTaxability(code: string | null | undefined): {
  shipping: ShippingTaxability;
  handling: ShippingTaxability;
} {
  const upper = (code ?? '').trim().toUpperCase();
  if (SHIPPING_TAXABLE_STATES.has(upper)) return { shipping: 'taxable', handling: 'taxable' };
  // California: common-carrier delivery is exempt when stated separately, handling is taxable.
  if (upper === 'CA') return { shipping: 'exempt_if_separate', handling: 'taxable' };
  if (SHIPPING_EXEMPT_STATES.has(upper)) return { shipping: 'exempt_if_separate', handling: 'follows_goods' };
  return { shipping: 'follows_goods', handling: 'follows_goods' };
}
