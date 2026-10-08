/**
 * What the sales tax setup screens know about each US state: the agency that
 * administers the tax, how intrastate sales are sourced, whether the state is a
 * Streamlined Sales Tax (SST) member, whether it lets a seller report on a cash
 * basis and the default due day.
 *
 * Mirrors `US_STATES` in `@weldsuite/books-domain/jurisdictions/us/states`
 * (the platform doesn't import the domain package). Generated from that file;
 * `us-sales-tax-states.test.ts` fails when the two drift apart. The values are
 * hints that pre-fill the registration form: the user's own registration
 * notice is the authority.
 */

export type SalesTaxSourcing = 'origin' | 'modified_origin' | 'destination';
export type SstMembership = 'full' | 'associate' | 'none';

export type StateProgram =
  | 'al_simplified_sellers_use_tax'
  | 'tx_single_local_use_rate'
  | 'co_suts'
  | 'la_remote_sellers_commission'
  | 'ak_arsstc'
  | 'home_rule_local_agencies';

/** When a certificate without an expiry date stops being valid (see the domain's `CertificateExpiryRule`). */
export type CertificateExpiryRule =
  | { kind: 'calendar_year_end' }
  | { kind: 'months_from_issue'; months: number }
  | { kind: 'months_from_last_purchase'; months: number };

export interface StateCertificateRule {
  /** Exempt reasons the rule covers; every reason when omitted. */
  reasons?: string[];
  /** Certificate forms the rule covers; every form when omitted. */
  forms?: string[];
  blanketOnly?: boolean;
  expiry: CertificateExpiryRule;
}

export interface SalesTaxStateInfo {
  code: string;
  name: string;
  /** A state-level sales (or gross receipts / excise) tax exists. */
  hasStateSalesTax: boolean;
  /** Local sales taxes exist (Alaska has local taxes only). */
  hasLocalSalesTax: boolean;
  intrastateSourcing: SalesTaxSourcing;
  sst: SstMembership;
  /** The agency that administers the state tax; null when the state has none. */
  agencyName: string | null;
  portalUrl: string | null;
  /** The state lets a seller report on a cash basis (otherwise accrual only). */
  cashBasisAllowed: boolean;
  /** Day of the month after the period the return is due; `last` = last day of that month. */
  defaultDueDay: number | 'last';
  /** Percent of the tax due kept for timely filing, with the cap per return in dollars when there is one. */
  vendorDiscount?: { percent: number; capPerReturn?: number };
  specialPrograms?: StateProgram[];
  /** Name of the tax when it isn't called sales tax. */
  taxName?: string;
  certificateRules?: StateCertificateRule[];
}

const STATES: readonly SalesTaxStateInfo[] = [
  {code:'AL',name:'Alabama',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'destination',sst:'none',agencyName:'Alabama Department of Revenue',portalUrl:'https://myalabamataxes.alabama.gov',cashBasisAllowed:false,defaultDueDay:20,specialPrograms:['al_simplified_sellers_use_tax','home_rule_local_agencies']},
  {code:'AK',name:'Alaska',hasStateSalesTax:false,hasLocalSalesTax:true,intrastateSourcing:'destination',sst:'none',agencyName:'Alaska Remote Seller Sales Tax Commission',portalUrl:'https://arsstc.org',cashBasisAllowed:false,defaultDueDay:'last',specialPrograms:['ak_arsstc','home_rule_local_agencies']},
  {code:'AZ',name:'Arizona',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'origin',sst:'none',agencyName:'Arizona Department of Revenue',portalUrl:'https://azdor.gov',cashBasisAllowed:true,defaultDueDay:20,taxName:'Transaction privilege tax'},
  {code:'AR',name:'Arkansas',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'destination',sst:'full',agencyName:'Arkansas Department of Finance and Administration',portalUrl:'https://atap.arkansas.gov',cashBasisAllowed:false,defaultDueDay:20},
  {code:'CA',name:'California',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'modified_origin',sst:'none',agencyName:'California Department of Tax and Fee Administration',portalUrl:'https://onlineservices.cdtfa.ca.gov',cashBasisAllowed:false,defaultDueDay:'last'},
  {code:'CO',name:'Colorado',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'destination',sst:'none',agencyName:'Colorado Department of Revenue',portalUrl:'https://mytaxes.colorado.gov',cashBasisAllowed:false,defaultDueDay:20,specialPrograms:['co_suts','home_rule_local_agencies']},
  {code:'CT',name:'Connecticut',hasStateSalesTax:true,hasLocalSalesTax:false,intrastateSourcing:'destination',sst:'none',agencyName:'Connecticut Department of Revenue Services',portalUrl:'https://drs.ct.gov',cashBasisAllowed:false,defaultDueDay:'last'},
  {code:'DE',name:'Delaware',hasStateSalesTax:false,hasLocalSalesTax:false,intrastateSourcing:'destination',sst:'none',agencyName:null,portalUrl:null,cashBasisAllowed:false,defaultDueDay:20},
  {code:'DC',name:'District of Columbia',hasStateSalesTax:true,hasLocalSalesTax:false,intrastateSourcing:'destination',sst:'none',agencyName:'DC Office of Tax and Revenue',portalUrl:'https://mytax.dc.gov',cashBasisAllowed:false,defaultDueDay:20},
  {code:'FL',name:'Florida',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'destination',sst:'none',agencyName:'Florida Department of Revenue',portalUrl:'https://floridarevenue.com',cashBasisAllowed:false,defaultDueDay:20,vendorDiscount:{percent:2.5,capPerReturn:30},certificateRules:[{reasons:['resale'],forms:['state_form','other'],expiry:{kind:'calendar_year_end'}}]},
  {code:'GA',name:'Georgia',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'destination',sst:'full',agencyName:'Georgia Department of Revenue',portalUrl:'https://gtc.dor.ga.gov',cashBasisAllowed:true,defaultDueDay:20,vendorDiscount:{percent:3}},
  {code:'HI',name:'Hawaii',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'destination',sst:'none',agencyName:'Hawaii Department of Taxation',portalUrl:'https://hitax.hawaii.gov',cashBasisAllowed:true,defaultDueDay:20,taxName:'General excise tax'},
  {code:'ID',name:'Idaho',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'destination',sst:'none',agencyName:'Idaho State Tax Commission',portalUrl:'https://tap.tax.idaho.gov',cashBasisAllowed:false,defaultDueDay:20},
  {code:'IL',name:'Illinois',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'origin',sst:'none',agencyName:'Illinois Department of Revenue',portalUrl:'https://mytax.illinois.gov',cashBasisAllowed:false,defaultDueDay:20,vendorDiscount:{percent:1.75}},
  {code:'IN',name:'Indiana',hasStateSalesTax:true,hasLocalSalesTax:false,intrastateSourcing:'destination',sst:'full',agencyName:'Indiana Department of Revenue',portalUrl:'https://intime.dor.in.gov',cashBasisAllowed:false,defaultDueDay:20},
  {code:'IA',name:'Iowa',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'destination',sst:'full',agencyName:'Iowa Department of Revenue',portalUrl:'https://govconnect.iowa.gov',cashBasisAllowed:false,defaultDueDay:'last'},
  {code:'KS',name:'Kansas',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'destination',sst:'full',agencyName:'Kansas Department of Revenue',portalUrl:'https://www.kdor.ks.gov',cashBasisAllowed:false,defaultDueDay:25},
  {code:'KY',name:'Kentucky',hasStateSalesTax:true,hasLocalSalesTax:false,intrastateSourcing:'destination',sst:'full',agencyName:'Kentucky Department of Revenue',portalUrl:'https://revenue.ky.gov',cashBasisAllowed:false,defaultDueDay:20},
  {code:'LA',name:'Louisiana',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'destination',sst:'none',agencyName:'Louisiana Department of Revenue',portalUrl:'https://latap.revenue.louisiana.gov',cashBasisAllowed:false,defaultDueDay:20,specialPrograms:['la_remote_sellers_commission','home_rule_local_agencies']},
  {code:'ME',name:'Maine',hasStateSalesTax:true,hasLocalSalesTax:false,intrastateSourcing:'destination',sst:'none',agencyName:'Maine Revenue Services',portalUrl:'https://revenue.maine.gov',cashBasisAllowed:false,defaultDueDay:15},
  {code:'MD',name:'Maryland',hasStateSalesTax:true,hasLocalSalesTax:false,intrastateSourcing:'destination',sst:'none',agencyName:'Comptroller of Maryland',portalUrl:'https://interactive.marylandtaxes.gov',cashBasisAllowed:false,defaultDueDay:20},
  {code:'MA',name:'Massachusetts',hasStateSalesTax:true,hasLocalSalesTax:false,intrastateSourcing:'destination',sst:'none',agencyName:'Massachusetts Department of Revenue',portalUrl:'https://mtc.dor.state.ma.us',cashBasisAllowed:false,defaultDueDay:20},
  {code:'MI',name:'Michigan',hasStateSalesTax:true,hasLocalSalesTax:false,intrastateSourcing:'destination',sst:'full',agencyName:'Michigan Department of Treasury',portalUrl:'https://mto.treasury.michigan.gov',cashBasisAllowed:false,defaultDueDay:20},
  {code:'MN',name:'Minnesota',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'destination',sst:'full',agencyName:'Minnesota Department of Revenue',portalUrl:'https://www.mndor.state.mn.us/tp/eservices',cashBasisAllowed:false,defaultDueDay:20},
  {code:'MS',name:'Mississippi',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'origin',sst:'none',agencyName:'Mississippi Department of Revenue',portalUrl:'https://tap.dor.ms.gov',cashBasisAllowed:false,defaultDueDay:20},
  {code:'MO',name:'Missouri',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'origin',sst:'none',agencyName:'Missouri Department of Revenue',portalUrl:'https://mytax.mo.gov',cashBasisAllowed:false,defaultDueDay:20},
  {code:'MT',name:'Montana',hasStateSalesTax:false,hasLocalSalesTax:false,intrastateSourcing:'destination',sst:'none',agencyName:null,portalUrl:null,cashBasisAllowed:false,defaultDueDay:20},
  {code:'NE',name:'Nebraska',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'destination',sst:'full',agencyName:'Nebraska Department of Revenue',portalUrl:'https://revenue.nebraska.gov',cashBasisAllowed:false,defaultDueDay:20},
  {code:'NV',name:'Nevada',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'destination',sst:'full',agencyName:'Nevada Department of Taxation',portalUrl:'https://www.nevadatax.nv.gov',cashBasisAllowed:false,defaultDueDay:'last'},
  {code:'NH',name:'New Hampshire',hasStateSalesTax:false,hasLocalSalesTax:false,intrastateSourcing:'destination',sst:'none',agencyName:null,portalUrl:null,cashBasisAllowed:false,defaultDueDay:20},
  {code:'NJ',name:'New Jersey',hasStateSalesTax:true,hasLocalSalesTax:false,intrastateSourcing:'destination',sst:'full',agencyName:'New Jersey Division of Taxation',portalUrl:'https://www.njportal.com/taxation',cashBasisAllowed:false,defaultDueDay:20},
  {code:'NM',name:'New Mexico',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'destination',sst:'none',agencyName:'New Mexico Taxation and Revenue Department',portalUrl:'https://tap.state.nm.us',cashBasisAllowed:true,defaultDueDay:25,taxName:'Gross receipts tax'},
  {code:'NY',name:'New York',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'destination',sst:'none',agencyName:'New York State Department of Taxation and Finance',portalUrl:'https://www.tax.ny.gov',cashBasisAllowed:false,defaultDueDay:20,vendorDiscount:{percent:5,capPerReturn:200}},
  {code:'NC',name:'North Carolina',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'destination',sst:'full',agencyName:'North Carolina Department of Revenue',portalUrl:'https://www.ncdor.gov',cashBasisAllowed:false,defaultDueDay:20},
  {code:'ND',name:'North Dakota',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'destination',sst:'full',agencyName:'North Dakota Office of State Tax Commissioner',portalUrl:'https://apps.nd.gov/tax/tap',cashBasisAllowed:false,defaultDueDay:'last'},
  {code:'OH',name:'Ohio',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'origin',sst:'full',agencyName:'Ohio Department of Taxation',portalUrl:'https://tax.ohio.gov',cashBasisAllowed:false,defaultDueDay:23},
  {code:'OK',name:'Oklahoma',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'destination',sst:'full',agencyName:'Oklahoma Tax Commission',portalUrl:'https://oktap.tax.ok.gov',cashBasisAllowed:false,defaultDueDay:20},
  {code:'OR',name:'Oregon',hasStateSalesTax:false,hasLocalSalesTax:false,intrastateSourcing:'destination',sst:'none',agencyName:null,portalUrl:null,cashBasisAllowed:false,defaultDueDay:20},
  {code:'PA',name:'Pennsylvania',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'destination',sst:'none',agencyName:'Pennsylvania Department of Revenue',portalUrl:'https://mypath.pa.gov',cashBasisAllowed:false,defaultDueDay:20,vendorDiscount:{percent:1,capPerReturn:25}},
  {code:'RI',name:'Rhode Island',hasStateSalesTax:true,hasLocalSalesTax:false,intrastateSourcing:'destination',sst:'full',agencyName:'Rhode Island Division of Taxation',portalUrl:'https://taxportal.ri.gov',cashBasisAllowed:false,defaultDueDay:20},
  {code:'SC',name:'South Carolina',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'destination',sst:'none',agencyName:'South Carolina Department of Revenue',portalUrl:'https://mydorway.dor.sc.gov',cashBasisAllowed:false,defaultDueDay:20},
  {code:'SD',name:'South Dakota',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'destination',sst:'full',agencyName:'South Dakota Department of Revenue',portalUrl:'https://apps.sd.gov/rv23epath',cashBasisAllowed:false,defaultDueDay:20},
  {code:'TN',name:'Tennessee',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'origin',sst:'associate',agencyName:'Tennessee Department of Revenue',portalUrl:'https://tntap.tn.gov',cashBasisAllowed:false,defaultDueDay:20},
  {code:'TX',name:'Texas',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'origin',sst:'none',agencyName:'Texas Comptroller of Public Accounts',portalUrl:'https://comptroller.texas.gov/taxes/sales',cashBasisAllowed:false,defaultDueDay:20,vendorDiscount:{percent:0.5},specialPrograms:['tx_single_local_use_rate']},
  {code:'UT',name:'Utah',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'origin',sst:'full',agencyName:'Utah State Tax Commission',portalUrl:'https://tap.tax.utah.gov',cashBasisAllowed:false,defaultDueDay:'last'},
  {code:'VT',name:'Vermont',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'destination',sst:'full',agencyName:'Vermont Department of Taxes',portalUrl:'https://myvtax.vermont.gov',cashBasisAllowed:false,defaultDueDay:25},
  {code:'VA',name:'Virginia',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'origin',sst:'none',agencyName:'Virginia Department of Taxation',portalUrl:'https://www.tax.virginia.gov',cashBasisAllowed:false,defaultDueDay:20},
  {code:'WA',name:'Washington',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'destination',sst:'full',agencyName:'Washington State Department of Revenue',portalUrl:'https://secure.dor.wa.gov',cashBasisAllowed:true,defaultDueDay:25,certificateRules:[{reasons:['resale'],forms:['state_form','other'],expiry:{kind:'months_from_issue',months:48}}]},
  {code:'WV',name:'West Virginia',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'destination',sst:'full',agencyName:'West Virginia Tax Division',portalUrl:'https://mytaxes.wvtax.gov',cashBasisAllowed:false,defaultDueDay:20},
  {code:'WI',name:'Wisconsin',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'destination',sst:'full',agencyName:'Wisconsin Department of Revenue',portalUrl:'https://tap.revenue.wi.gov',cashBasisAllowed:false,defaultDueDay:'last'},
  {code:'WY',name:'Wyoming',hasStateSalesTax:true,hasLocalSalesTax:true,intrastateSourcing:'destination',sst:'full',agencyName:'Wyoming Department of Revenue',portalUrl:'https://excise-wyifs.wy.gov',cashBasisAllowed:false,defaultDueDay:'last'},
];

/** SST blanket certificates stay valid while purchases are at most 12 months apart. */
export const SST_BLANKET_RULE: StateCertificateRule = {
  forms: ['sst_f0003'],
  blanketOnly: true,
  expiry: { kind: 'months_from_last_purchase', months: 12 },
};

const BY_CODE = new Map(STATES.map((s) => [s.code, s]));

export function getSalesTaxState(code: string | null | undefined): SalesTaxStateInfo | undefined {
  return code ? BY_CODE.get(code.trim().toUpperCase()) : undefined;
}

/** Every state, DC included, for pickers that list all of them (certificates). */
export function allUsStates(): readonly SalesTaxStateInfo[] {
  return STATES;
}

/** States that levy a sales tax a seller can register for (state or local). */
export function salesTaxStates(): SalesTaxStateInfo[] {
  return STATES.filter((s) => s.hasStateSalesTax || s.hasLocalSalesTax);
}

/** "Texas" for `TX`; an unknown code shows as it is. */
export function salesTaxStateName(code: string | null | undefined): string {
  return getSalesTaxState(code)?.name ?? code ?? '';
}

/** The day of the month the state's return is due, as a number (31 stands for the last day). */
export function defaultDueDayNumber(state: SalesTaxStateInfo): number {
  return state.defaultDueDay === 'last' ? 31 : state.defaultDueDay;
}

/** The name a new agency gets when the user doesn't type one. */
export function defaultAgencyName(state: SalesTaxStateInfo): string {
  return state.agencyName ?? `${state.name} Department of Revenue`;
}

/** The state's own certificate rules plus the SST blanket rule for SST members. */
export function certificateRulesOf(code: string | null | undefined): StateCertificateRule[] {
  const info = getSalesTaxState(code);
  if (!info) return [];
  const own = info.certificateRules ?? [];
  return info.sst === 'none' ? own : [...own, SST_BLANKET_RULE];
}

/** Whether a rule covers a certificate of this reason and form. */
export function certificateRuleApplies(
  rule: StateCertificateRule,
  certificate: { reason: string; form: string; blanket: boolean },
): boolean {
  if (rule.reasons && !rule.reasons.includes(certificate.reason)) return false;
  if (rule.forms && !rule.forms.includes(certificate.form)) return false;
  if (rule.blanketOnly && !certificate.blanket) return false;
  return true;
}
