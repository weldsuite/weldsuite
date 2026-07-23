/**
 * WeldData (Lemlist) filter catalog — hard-coded.
 *
 * The lead database exposes its filters via `GET /database/filters`, but that
 * payload has raw `filterId` codes, no display labels, and option values only
 * for some filters. Rather than render code-named text boxes, we pin a curated
 * catalog here: every filter gets a human label, the correct input affordance,
 * and (for selects) the exact option list the provider accepts.
 *
 * Each entry's `filterId` and select `options` mirror the provider's
 * `/database/filters` response verbatim, so the search payload
 * (`{ filterId, values }`) stays valid. `modes` maps the provider's
 * `mode: ['leads' | 'companies']` onto the platform's person/company tabs.
 *
 * To add or change a filter, edit this list — nothing else needs to change.
 */
import type { LemlistFilterInputType } from '@weldsuite/app-api-client/schemas/welddata';

export type WelddataFilterMode = 'person' | 'company';

export interface WelddataFilterOption {
  value: string;
  label: string;
}

export interface WelddataFilterDef {
  filterId: string;
  /** Short, human label shown above the input. */
  label: string;
  /** Input affordance to render. */
  inputType: Extract<LemlistFilterInputType, 'text' | 'number' | 'range' | 'select'>;
  /** Which tabs the filter applies to (person = leads, company = companies). */
  modes: WelddataFilterMode[];
  /** Full provider description — surfaced as a tooltip / hint. */
  description?: string;
  /** Placeholder for free-text / number inputs. */
  placeholder?: string;
  /** Options for `select` inputs (value === provider value). */
  options?: WelddataFilterOption[];
  /** Bounds for `range` inputs. */
  range?: { min: number; max: number; percentage?: boolean };
  /**
   * Marks a `text` filter as a location field backed by Mapbox autocomplete.
   * `'country'` suggests countries only; `'city'` suggests cities/regions.
   */
  location?: 'country' | 'city';
}

/** Build select options from a plain provider value list (value === label). */
function opts(values: string[]): WelddataFilterOption[] {
  return values.map((v) => ({ value: v, label: v }));
}

const INDUSTRIES = [
  'Accounting', 'Administration of Justice', 'Advertising Services', 'Airlines and Aviation',
  'Apparel Manufacturing', 'Appliances, Electrical, and Electronics Manufacturing',
  'Architecture and Planning', 'Artists and Writers', 'Building Construction',
  'Business Consulting and Services', 'Capital Markets', 'Chemical Manufacturing',
  'Civic and Social Organizations', 'Civil Engineering',
  'Climate Technology Products Manufacturing', 'Collection Agencies', 'Community Services',
  'Computers and Electronics Manufacturing', 'Credit Intermediation', 'Design Services',
  'E-Learning Providers', 'Economic Programs', 'Electric Power Generation',
  'Electric Power Transmission, Control, and Distribution', 'Engineering Services',
  'Environmental Quality Programs', 'Equipment Rental Services', 'Events Services',
  'Fabricated Metal Products', 'Facilities Services', 'Farming',
  'Food and Beverage Manufacturing', 'Food and Beverage Retail', 'Food and Beverage Services',
  'Forestry and Logging', 'Freight and Package Transportation', 'Fundraising', 'Funds and Trusts',
  'Furniture and Home Furnishings Manufacturing', 'Glass, Ceramics and Concrete Manufacturing',
  'Ground Passenger Transportation', 'Health and Human Services', 'Higher Education',
  'Hospitality', 'Hospitals', 'Household Services', 'Housing and Community Development',
  'Individual and Family Services', 'Insurance', 'IT Services and IT Consulting',
  'Leather Product Manufacturing', 'Legal Services', 'Machinery Manufacturing',
  'Maritime Transportation', 'Media and Telecommunications', 'Medical Equipment Manufacturing',
  'Medical Practices', 'Military and International Affairs', 'Mining',
  'Museums, Historical Sites, and Zoos', 'Musicians', 'Natural Gas Distribution',
  'Non-profit Organizations', 'Nursing Homes and Residential Care Facilities',
  'Office Administration', 'Oil and Coal Product Manufacturing', 'Oil and Gas',
  'Online and Mail Order Retail', 'Paper and Forest Product Manufacturing',
  'Performing Arts and Spectator Sports', 'Personal and Laundry Services',
  'Philanthropic Fundraising Services', 'Photography', 'Pipeline Transportation',
  'Plastics and Rubber Product Manufacturing', 'Postal Services',
  'Primary and Secondary Education', 'Primary Metal Manufacturing', 'Printing Services',
  'Professional Training and Coaching', 'Public Policy Offices', 'Rail Transportation',
  'Ranching and Fisheries', 'Real Estate', 'Recreational Facilities', 'Religious Institutions',
  'Repair and Maintenance', 'Research Services', 'Retail Apparel and Fashion',
  'Retail Appliances, Electrical, and Electronic Equipment', 'Retail Art Dealers',
  'Retail Art Supplies', 'Retail Books and Printed News',
  'Retail Building Materials and Garden Equipment', 'Retail Florists',
  'Retail Furniture and Home Furnishings', 'Retail Gasoline',
  'Retail Health and Personal Care Products', 'Retail Luxury Goods and Jewelry',
  'Retail Motor Vehicles', 'Retail Musical Instruments', 'Retail Office Equipment',
  'Retail Office Supplies and Gifts', 'Retail Recyclable Materials & Used Merchandise',
  'Security and Investigations', 'Services for Renewable Energy', 'Space Research and Technology',
  'Specialty Trade Contractors', 'Sporting Goods Manufacturing', 'Staffing and Recruiting',
  'Technical and Vocational Training', 'Technology, Information and Internet',
  'Telephone Call Centers', 'Textile Manufacturing', 'Tobacco Manufacturing',
  'Translation and Localization', 'Transportation Equipment Manufacturing', 'Travel Arrangements',
  'Truck Transportation', 'Veterinary Services', 'Warehousing and Storage',
  'Water, Waste, Steam, and Air Conditioning Services', 'Wholesale Alcoholic Beverages',
  'Wholesale Apparel and Sewing Supplies', 'Wholesale Appliances, Electrical, and Electronics',
  'Wholesale Building Materials', 'Wholesale Chemical and Allied Products',
  'Wholesale Computer Equipment', 'Wholesale Drugs and Sundries', 'Wholesale Food and Beverage',
  'Wholesale Footwear', 'Wholesale Furniture and Home Furnishings',
  'Wholesale Hardware, Plumbing, Heating Equipment', 'Wholesale Import and Export',
  'Wholesale Luxury Goods and Jewelry', 'Wholesale Machinery', 'Wholesale Metals and Minerals',
  'Wholesale Motor Vehicles and Parts', 'Wholesale Paper Products',
  'Wholesale Petroleum and Petroleum Products', 'Wholesale Photography Equipment and Supplies',
  'Wholesale Raw Farm Products', 'Wholesale Recyclable Materials', 'Wood Product Manufacturing',
  'Writing and Editing',
];

const REGIONS = [
  'Europe', 'Western Europe', 'Southern Europe', 'Northern Europe', 'Eastern Europe', 'Balkans',
  'DACH', 'America', 'North America', 'Central America', 'Caribbean', 'South America', 'Africa',
  'North Africa (Maghreb)', 'West Africa', 'Central Africa', 'East Africa', 'Southern Africa',
  'Asia', 'East Asia', 'Southeast Asia', 'South Asia', 'Central Asia', 'Middle East', 'Oceania',
];

/**
 * The curated filter catalog. Order here is the order shown in the sidebar.
 * Internal/duplicate provider filters (`*ByIds`, LinkedIn slug, exact-match
 * title variant) are intentionally omitted — they aren't user-facing.
 */
export const WELDDATA_FILTERS: WelddataFilterDef[] = [
  // --- Role & seniority (people) ---------------------------------------------
  {
    filterId: 'currentTitle',
    label: 'Current job title',
    inputType: 'text',
    modes: ['person'],
    placeholder: 'e.g. Head of Sales, CTO',
    description:
      "Filter by the lead's current job title. Matches both raw and normalized titles, with fuzzy handling of diacritics and word order.",
  },
  {
    filterId: 'pastTitle',
    label: 'Past job title',
    inputType: 'text',
    modes: ['person'],
    placeholder: 'e.g. Founder, Sales Director',
    description:
      'Filter by a job title the lead held in any past experience (not their current one).',
  },
  {
    filterId: 'seniority',
    label: 'Seniority',
    inputType: 'select',
    modes: ['person'],
    description: "Filter by the lead's inferred seniority level. Target decision-makers at the right altitude.",
    options: opts([
      'Entry-Level',
      'Mid-Level (Individual Contributor)',
      'Upper Mid-Level / Experienced IC',
      'People Management / Leadership',
      'Department Leadership',
      'Executive Leadership',
      'Ownership / Firm Leadership',
    ]),
  },
  {
    filterId: 'department',
    label: 'Department',
    inputType: 'select',
    modes: ['person'],
    description: 'Filter by the functional department, regardless of exact job title.',
    options: opts([
      'Accounting', 'Administrative', 'Arts and Design', 'Business Development',
      'Community and Social Services', 'Consulting', 'Education', 'Engineering',
      'Entrepreneurship', 'Finance', 'Healthcare Services', 'Human Resources',
      'Information Technology', 'Legal', 'Marketing', 'Media and Communication',
      'Military and Protective Services', 'Operations', 'Other', 'Product Management',
      'Program and Project Management', 'Purchasing', 'Quality Assurance', 'Real Estate',
      'Research', 'Sales', 'Support',
    ]),
  },
  {
    filterId: 'currentPositionTenure',
    label: 'Current position tenure',
    inputType: 'select',
    modes: ['person'],
    description: 'How long the lead has held their current position.',
    options: opts([
      'Less than 6 months',
      '6 months to 1 year',
      '1 to 3 years',
      '3 to 5 years',
      'More than 5 years',
    ]),
  },
  {
    filterId: 'yearsOfExperience',
    label: 'Years of experience',
    inputType: 'select',
    modes: ['person'],
    description: "The lead's total years of professional experience.",
    options: opts([
      'less than 1 year',
      '1 to 2 years',
      '2 to 5 years',
      '5 to 10 years',
      'More than 10 years',
    ]),
  },

  // --- Location (people) -----------------------------------------------------
  {
    filterId: 'country',
    label: 'Country',
    inputType: 'text',
    location: 'country',
    modes: ['person'],
    placeholder: 'e.g. United States, France',
    description: "Filter by the lead's country of residence (where the person lives).",
  },
  {
    filterId: 'location',
    label: 'City / State',
    inputType: 'text',
    location: 'city',
    modes: ['person'],
    placeholder: 'e.g. Paris, Bay Area, Berlin',
    description: "Filter by the lead's city or state of residence. More granular than country.",
  },
  {
    filterId: 'region',
    label: 'Region',
    inputType: 'select',
    modes: ['person'],
    description: "Filter by the lead's geographic region. Region names expand to a curated country list.",
    options: opts(REGIONS),
  },

  // --- Company (people + companies) ------------------------------------------
  {
    filterId: 'currentCompany',
    label: 'Current company',
    inputType: 'text',
    modes: ['person', 'company'],
    placeholder: 'e.g. Stripe, Datadog',
    description: "Filter by the name of the lead's current employer (current experience only).",
  },
  {
    filterId: 'pastCompany',
    label: 'Past company',
    inputType: 'text',
    modes: ['person'],
    placeholder: 'e.g. Stripe, Datadog',
    description: 'Filter by a company the lead used to work for but has since left.',
  },
  {
    filterId: 'currentCompanySubIndustry',
    label: 'Company industry',
    inputType: 'select',
    modes: ['person', 'company'],
    description: "Filter by the industry of the lead's current company.",
    options: opts(INDUSTRIES),
  },
  {
    filterId: 'currentCompanyHeadcount',
    label: 'Company size',
    inputType: 'select',
    modes: ['person', 'company'],
    description: 'Filter by the headcount bucket of the current company (SMB, mid-market, enterprise).',
    options: opts(['1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5001-10000', '10001+']),
  },
  {
    filterId: 'currentCompanyCountry',
    label: 'Company country',
    inputType: 'text',
    location: 'country',
    modes: ['person', 'company'],
    placeholder: 'e.g. United States, Germany',
    description: "Filter by the country of the current company's headquarters.",
  },
  {
    filterId: 'currentCompanyRegion',
    label: 'Company region',
    inputType: 'select',
    modes: ['person', 'company'],
    description: "Filter by the region of the current company's headquarters.",
    options: opts(REGIONS),
  },
  {
    filterId: 'currentCompanyLocation',
    label: 'Company city / state',
    inputType: 'text',
    location: 'city',
    modes: ['person', 'company'],
    placeholder: 'e.g. San Francisco, London',
    description: "Filter by the city/state where the role is based. For companies, the HQ city.",
  },
  {
    filterId: 'currentCompanyMarket',
    label: 'Company market',
    inputType: 'select',
    modes: ['person', 'company'],
    description: 'Filter by the market the current company serves (go-to-market motion).',
    options: opts(['B2C', 'B2B', 'B2B/B2C']),
  },
  {
    filterId: 'currentCompanyType',
    label: 'Company type',
    inputType: 'select',
    modes: ['person', 'company'],
    description: 'Filter by the company type or legal status.',
    options: opts([
      'Public Company', 'Privately Held', 'Nonprofit', 'Educational Institution', 'Educational',
      'Partnership', 'Self Employed', 'Self Owned', 'Government Agency', 'Sole Proprietorship',
    ]),
  },
  {
    filterId: 'currentCompanyRevenue',
    label: 'Company revenue',
    inputType: 'select',
    modes: ['company'],
    description: 'Filter companies by annual revenue bucket (USD). Companies tab only.',
    options: opts([
      '$0 - $500K', '$500K - $1M', '$1M - $3M', '$3M - $5M', '$5M - $10M',
      '$10M - $20M', '$20M - $30M', '$30M+',
    ]),
  },
  {
    filterId: 'currentCompanyFounded',
    label: 'Company founded year',
    inputType: 'range',
    modes: ['person', 'company'],
    description: 'Filter by the founding-year range of the current company.',
    range: { min: 1900, max: 2026 },
  },

  // --- Signals & intent ------------------------------------------------------
  {
    filterId: 'currentCompanySizeGrowth',
    label: 'Company size growth (6m)',
    inputType: 'range',
    modes: ['person', 'company'],
    description: '6-month employee headcount growth rate (%). Target fast-growing companies.',
    range: { min: -100, max: 200, percentage: true },
  },
  {
    filterId: 'currentCompanyTechnologies',
    label: 'Company technologies',
    inputType: 'text',
    modes: ['person', 'company'],
    placeholder: 'e.g. Salesforce, AWS, Segment',
    description: 'Filter by technologies used by the current company.',
  },
  {
    filterId: 'currentCompanyLastFundingRoundAt',
    label: 'Last funding date',
    inputType: 'select',
    modes: ['person', 'company'],
    description: 'How recently the current company raised its last funding round.',
    options: opts([
      'Less than 1 month',
      '1 month to 3 months',
      '3 months to 6 months',
      'More than 6 months',
    ]),
  },
  {
    filterId: 'keywordInCompany',
    label: 'Keyword in company',
    inputType: 'text',
    modes: ['person', 'company'],
    placeholder: 'e.g. fintech, open source',
    description: 'Full-text keyword search on company name and description.',
  },
  {
    filterId: 'numberOfLeadsPerCompany',
    label: 'Leads per company',
    inputType: 'range',
    modes: ['company'],
    description: 'Filter companies by how many matching leads they have.',
    range: { min: 1, max: 1000 },
  },

  // --- Profile (people) ------------------------------------------------------
  {
    filterId: 'skill',
    label: 'Skills',
    inputType: 'text',
    modes: ['person'],
    placeholder: 'e.g. Python, Account-Based Marketing',
    description: 'Filter by a skill the lead declared on their profile.',
  },
  {
    filterId: 'interest',
    label: 'Interests',
    inputType: 'text',
    modes: ['person'],
    placeholder: 'e.g. a followed company or topic',
    description: 'Filter by an interest declared on the profile (a followed company, influencer or topic).',
  },
  {
    filterId: 'schoolName',
    label: 'School name',
    inputType: 'text',
    modes: ['person'],
    placeholder: 'e.g. Stanford, INSEAD',
    description: 'Filter by an educational institution the lead attended (any education entry).',
  },
  {
    filterId: 'schoolDegree',
    label: 'School degree',
    inputType: 'text',
    modes: ['person'],
    placeholder: 'e.g. MBA, Computer Science',
    description: 'Filter by the program or degree the lead pursued.',
  },
  {
    filterId: 'keyword',
    label: 'Keyword in profile',
    inputType: 'text',
    modes: ['person'],
    placeholder: 'e.g. AI, climate',
    description: 'Free-text search across the full profile: summary, skills, interests, education and more.',
  },
  {
    filterId: 'numberOfConnections',
    label: 'Number of connections',
    inputType: 'select',
    modes: ['person'],
    description: "Filter by the lead's LinkedIn connections-count bucket.",
    options: opts(['less than 50', '51-250', '251-500', '500+']),
  },

  // --- Links (advanced) ------------------------------------------------------
  {
    filterId: 'leadLinkedInUrl',
    label: 'Contact LinkedIn URL',
    inputType: 'text',
    modes: ['person'],
    placeholder: 'https://linkedin.com/in/…',
    description: "Filter by the lead's LinkedIn profile URL.",
  },
  {
    filterId: 'currentCompanyLinkedInUrl',
    label: 'Company LinkedIn URL',
    inputType: 'text',
    modes: ['person', 'company'],
    placeholder: 'https://linkedin.com/company/…',
    description: "Filter by the company's LinkedIn URL.",
  },
  {
    filterId: 'currentCompanyWebsiteUrl',
    label: 'Company website URL',
    inputType: 'text',
    modes: ['person', 'company'],
    placeholder: 'https://example.com',
    description: "Filter by the company's website URL.",
  },
];

/** The filters applicable to a given tab, in display order. */
export function filtersForKind(kind: WelddataFilterMode): WelddataFilterDef[] {
  return WELDDATA_FILTERS.filter((f) => f.modes.includes(kind));
}
