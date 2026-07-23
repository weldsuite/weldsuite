// New onboarding types - single-page form

export interface OnboardingFormData {
  // Profile section
  firstName: string;
  lastName: string;
  productUpdates: boolean;

  // Organization section
  organizationName: string;
  organizationType: string;
  country: string;
  organizationSize: string;
  referralSource: string;
  region: string;

  // Role section
  role: string;

  // Apps section (optional, as string array for serialization)
  selectedApps?: string[];
}

export const ORGANIZATION_TYPES = [
  { id: 'startup', label: 'Startup' },
  { id: 'smb', label: 'Small/Medium Business' },
  { id: 'enterprise', label: 'Enterprise' },
  { id: 'agency', label: 'Agency' },
  { id: 'nonprofit', label: 'Non-profit' },
  { id: 'other', label: 'Other' },
] as const;

export const ORGANIZATION_SIZES = [
  { id: 'just-me', label: 'Just me' },
  { id: '2-10', label: '2-10 employees' },
  { id: '11-50', label: '11-50 employees' },
  { id: '51-200', label: '51-200 employees' },
  { id: '201-500', label: '201-500 employees' },
  { id: '500+', label: '500+ employees' },
] as const;

export const ROLES = [
  { id: 'sales', label: 'Sales' },
  { id: 'marketing', label: 'Marketing' },
  { id: 'engineering', label: 'Engineering' },
  { id: 'product', label: 'Product' },
  { id: 'design', label: 'Design' },
  { id: 'customer-success', label: 'Customer Success' },
  { id: 'operations', label: 'Operations' },
  { id: 'finance', label: 'Finance' },
  { id: 'hr', label: 'Human Resources' },
  { id: 'executive', label: 'Executive' },
  { id: 'other', label: 'Other' },
] as const;

export const COUNTRIES = [
  { code: 'AF', name: 'Afghanistan' },
  { code: 'AL', name: 'Albania' },
  { code: 'DZ', name: 'Algeria' },
  { code: 'AD', name: 'Andorra' },
  { code: 'AO', name: 'Angola' },
  { code: 'AG', name: 'Antigua and Barbuda' },
  { code: 'AR', name: 'Argentina' },
  { code: 'AM', name: 'Armenia' },
  { code: 'AU', name: 'Australia' },
  { code: 'AT', name: 'Austria' },
  { code: 'AZ', name: 'Azerbaijan' },
  { code: 'BS', name: 'Bahamas' },
  { code: 'BH', name: 'Bahrain' },
  { code: 'BD', name: 'Bangladesh' },
  { code: 'BB', name: 'Barbados' },
  { code: 'BY', name: 'Belarus' },
  { code: 'BE', name: 'Belgium' },
  { code: 'BZ', name: 'Belize' },
  { code: 'BJ', name: 'Benin' },
  { code: 'BT', name: 'Bhutan' },
  { code: 'BO', name: 'Bolivia' },
  { code: 'BA', name: 'Bosnia and Herzegovina' },
  { code: 'BW', name: 'Botswana' },
  { code: 'BR', name: 'Brazil' },
  { code: 'BN', name: 'Brunei' },
  { code: 'BG', name: 'Bulgaria' },
  { code: 'BF', name: 'Burkina Faso' },
  { code: 'BI', name: 'Burundi' },
  { code: 'CV', name: 'Cabo Verde' },
  { code: 'KH', name: 'Cambodia' },
  { code: 'CM', name: 'Cameroon' },
  { code: 'CA', name: 'Canada' },
  { code: 'CF', name: 'Central African Republic' },
  { code: 'TD', name: 'Chad' },
  { code: 'CL', name: 'Chile' },
  { code: 'CN', name: 'China' },
  { code: 'CO', name: 'Colombia' },
  { code: 'KM', name: 'Comoros' },
  { code: 'CG', name: 'Congo' },
  { code: 'CD', name: 'Congo (Democratic Republic)' },
  { code: 'CR', name: 'Costa Rica' },
  { code: 'HR', name: 'Croatia' },
  { code: 'CU', name: 'Cuba' },
  { code: 'CY', name: 'Cyprus' },
  { code: 'CZ', name: 'Czech Republic' },
  { code: 'DK', name: 'Denmark' },
  { code: 'DJ', name: 'Djibouti' },
  { code: 'DM', name: 'Dominica' },
  { code: 'DO', name: 'Dominican Republic' },
  { code: 'EC', name: 'Ecuador' },
  { code: 'EG', name: 'Egypt' },
  { code: 'SV', name: 'El Salvador' },
  { code: 'GQ', name: 'Equatorial Guinea' },
  { code: 'ER', name: 'Eritrea' },
  { code: 'EE', name: 'Estonia' },
  { code: 'SZ', name: 'Eswatini' },
  { code: 'ET', name: 'Ethiopia' },
  { code: 'FJ', name: 'Fiji' },
  { code: 'FI', name: 'Finland' },
  { code: 'FR', name: 'France' },
  { code: 'GA', name: 'Gabon' },
  { code: 'GM', name: 'Gambia' },
  { code: 'GE', name: 'Georgia' },
  { code: 'DE', name: 'Germany' },
  { code: 'GH', name: 'Ghana' },
  { code: 'GR', name: 'Greece' },
  { code: 'GD', name: 'Grenada' },
  { code: 'GT', name: 'Guatemala' },
  { code: 'GN', name: 'Guinea' },
  { code: 'GW', name: 'Guinea-Bissau' },
  { code: 'GY', name: 'Guyana' },
  { code: 'HT', name: 'Haiti' },
  { code: 'HN', name: 'Honduras' },
  { code: 'HU', name: 'Hungary' },
  { code: 'IS', name: 'Iceland' },
  { code: 'IN', name: 'India' },
  { code: 'ID', name: 'Indonesia' },
  { code: 'IR', name: 'Iran' },
  { code: 'IQ', name: 'Iraq' },
  { code: 'IE', name: 'Ireland' },
  { code: 'IL', name: 'Israel' },
  { code: 'IT', name: 'Italy' },
  { code: 'CI', name: 'Ivory Coast' },
  { code: 'JM', name: 'Jamaica' },
  { code: 'JP', name: 'Japan' },
  { code: 'JO', name: 'Jordan' },
  { code: 'KZ', name: 'Kazakhstan' },
  { code: 'KE', name: 'Kenya' },
  { code: 'KI', name: 'Kiribati' },
  { code: 'KP', name: 'Korea (North)' },
  { code: 'KR', name: 'Korea (South)' },
  { code: 'KW', name: 'Kuwait' },
  { code: 'KG', name: 'Kyrgyzstan' },
  { code: 'LA', name: 'Laos' },
  { code: 'LV', name: 'Latvia' },
  { code: 'LB', name: 'Lebanon' },
  { code: 'LS', name: 'Lesotho' },
  { code: 'LR', name: 'Liberia' },
  { code: 'LY', name: 'Libya' },
  { code: 'LI', name: 'Liechtenstein' },
  { code: 'LT', name: 'Lithuania' },
  { code: 'LU', name: 'Luxembourg' },
  { code: 'MG', name: 'Madagascar' },
  { code: 'MW', name: 'Malawi' },
  { code: 'MY', name: 'Malaysia' },
  { code: 'MV', name: 'Maldives' },
  { code: 'ML', name: 'Mali' },
  { code: 'MT', name: 'Malta' },
  { code: 'MH', name: 'Marshall Islands' },
  { code: 'MR', name: 'Mauritania' },
  { code: 'MU', name: 'Mauritius' },
  { code: 'MX', name: 'Mexico' },
  { code: 'FM', name: 'Micronesia' },
  { code: 'MD', name: 'Moldova' },
  { code: 'MC', name: 'Monaco' },
  { code: 'MN', name: 'Mongolia' },
  { code: 'ME', name: 'Montenegro' },
  { code: 'MA', name: 'Morocco' },
  { code: 'MZ', name: 'Mozambique' },
  { code: 'MM', name: 'Myanmar' },
  { code: 'NA', name: 'Namibia' },
  { code: 'NR', name: 'Nauru' },
  { code: 'NP', name: 'Nepal' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'NI', name: 'Nicaragua' },
  { code: 'NE', name: 'Niger' },
  { code: 'NG', name: 'Nigeria' },
  { code: 'MK', name: 'North Macedonia' },
  { code: 'NO', name: 'Norway' },
  { code: 'OM', name: 'Oman' },
  { code: 'PK', name: 'Pakistan' },
  { code: 'PW', name: 'Palau' },
  { code: 'PS', name: 'Palestine' },
  { code: 'PA', name: 'Panama' },
  { code: 'PG', name: 'Papua New Guinea' },
  { code: 'PY', name: 'Paraguay' },
  { code: 'PE', name: 'Peru' },
  { code: 'PH', name: 'Philippines' },
  { code: 'PL', name: 'Poland' },
  { code: 'PT', name: 'Portugal' },
  { code: 'QA', name: 'Qatar' },
  { code: 'RO', name: 'Romania' },
  { code: 'RU', name: 'Russia' },
  { code: 'RW', name: 'Rwanda' },
  { code: 'KN', name: 'Saint Kitts and Nevis' },
  { code: 'LC', name: 'Saint Lucia' },
  { code: 'VC', name: 'Saint Vincent and the Grenadines' },
  { code: 'WS', name: 'Samoa' },
  { code: 'SM', name: 'San Marino' },
  { code: 'ST', name: 'Sao Tome and Principe' },
  { code: 'SA', name: 'Saudi Arabia' },
  { code: 'SN', name: 'Senegal' },
  { code: 'RS', name: 'Serbia' },
  { code: 'SC', name: 'Seychelles' },
  { code: 'SL', name: 'Sierra Leone' },
  { code: 'SG', name: 'Singapore' },
  { code: 'SK', name: 'Slovakia' },
  { code: 'SI', name: 'Slovenia' },
  { code: 'SB', name: 'Solomon Islands' },
  { code: 'SO', name: 'Somalia' },
  { code: 'ZA', name: 'South Africa' },
  { code: 'SS', name: 'South Sudan' },
  { code: 'ES', name: 'Spain' },
  { code: 'LK', name: 'Sri Lanka' },
  { code: 'SD', name: 'Sudan' },
  { code: 'SR', name: 'Suriname' },
  { code: 'SE', name: 'Sweden' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'SY', name: 'Syria' },
  { code: 'TW', name: 'Taiwan' },
  { code: 'TJ', name: 'Tajikistan' },
  { code: 'TZ', name: 'Tanzania' },
  { code: 'TH', name: 'Thailand' },
  { code: 'TL', name: 'Timor-Leste' },
  { code: 'TG', name: 'Togo' },
  { code: 'TO', name: 'Tonga' },
  { code: 'TT', name: 'Trinidad and Tobago' },
  { code: 'TN', name: 'Tunisia' },
  { code: 'TR', name: 'Turkey' },
  { code: 'TM', name: 'Turkmenistan' },
  { code: 'TV', name: 'Tuvalu' },
  { code: 'UG', name: 'Uganda' },
  { code: 'UA', name: 'Ukraine' },
  { code: 'AE', name: 'United Arab Emirates' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'US', name: 'United States' },
  { code: 'UY', name: 'Uruguay' },
  { code: 'UZ', name: 'Uzbekistan' },
  { code: 'VU', name: 'Vanuatu' },
  { code: 'VA', name: 'Vatican City' },
  { code: 'VE', name: 'Venezuela' },
  { code: 'VN', name: 'Vietnam' },
  { code: 'YE', name: 'Yemen' },
  { code: 'ZM', name: 'Zambia' },
  { code: 'ZW', name: 'Zimbabwe' },
] as const;

export const REFERRAL_SOURCES = [
  { id: 'google', label: 'Google Search' },
  { id: 'social', label: 'Social Media' },
  { id: 'friend', label: 'Friend or Colleague' },
  { id: 'blog', label: 'Blog or Article' },
  { id: 'podcast', label: 'Podcast' },
  { id: 'event', label: 'Event or Conference' },
  { id: 'ad', label: 'Online Advertisement' },
  { id: 'other', label: 'Other' },
] as const;

export const NEON_REGIONS = [
  { id: 'aws-eu-central-1', label: 'Europe (Frankfurt)', flag: '\u{1F1EA}\u{1F1FA}' },
  { id: 'aws-eu-west-2', label: 'Europe (London)', flag: '\u{1F1EC}\u{1F1E7}' },
  { id: 'aws-us-east-1', label: 'US East (Virginia)', flag: '\u{1F1FA}\u{1F1F8}' },
  { id: 'aws-us-west-2', label: 'US West (Oregon)', flag: '\u{1F1FA}\u{1F1F8}' },
  { id: 'aws-ap-southeast-1', label: 'Asia Pacific (Singapore)', flag: '\u{1F1F8}\u{1F1EC}' },
  { id: 'aws-ap-southeast-2', label: 'Asia Pacific (Sydney)', flag: '\u{1F1E6}\u{1F1FA}' },
] as const;

const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IS', 'IT', 'LV', 'LI', 'LT', 'LU', 'MT', 'NL', 'NO', 'PL', 'PT',
  'RO', 'SK', 'SI', 'ES', 'SE', 'CH', 'UA', 'BY', 'MD', 'BA', 'RS', 'ME',
  'MK', 'AL', 'AD', 'MC', 'SM', 'VA',
]);

const UK_IE_COUNTRIES = new Set(['GB', 'IE']);

const US_CA_COUNTRIES = new Set(['US', 'CA', 'MX']);

const APAC_SOUTHEAST_COUNTRIES = new Set([
  'SG', 'MY', 'TH', 'VN', 'PH', 'ID', 'MM', 'KH', 'LA', 'BN', 'TL',
  'IN', 'BD', 'LK', 'PK', 'NP', 'BT', 'CN', 'JP', 'KR', 'TW', 'HK', 'MO',
]);

const APAC_OCEANIA_COUNTRIES = new Set(['AU', 'NZ', 'FJ', 'PG', 'WS', 'TO', 'VU', 'SB', 'KI', 'NR', 'TV', 'MH', 'PW', 'FM']);

const COUNTRY_CODES = new Set<string>(COUNTRIES.map((c) => c.code));

/**
 * Best-effort, client-side detection of the user's country from their browser
 * locale. The platform is a Vite SPA with no server, so there's no request-time
 * geo header to rely on — we derive the country from the region subtag of the
 * user's configured languages (e.g. "nl-NL" -> "NL"), falling back to inferring
 * a region from the primary locale, and finally to `fallback`.
 */
export function detectUserCountry(fallback = 'NL'): string {
  if (typeof navigator === 'undefined') return fallback;

  const candidates = [
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    navigator.language,
  ].filter((l): l is string => Boolean(l));

  // Prefer an explicit region subtag (most reliable signal).
  for (const lang of candidates) {
    const region = lang
      .split('-')
      .map((part) => part.toUpperCase())
      .find((part) => /^[A-Z]{2}$/.test(part) && COUNTRY_CODES.has(part));
    if (region) return region;
  }

  // Otherwise, let Intl infer the most likely region for the primary locale.
  for (const lang of candidates) {
    try {
      const locale = new Intl.Locale(lang);
      const maximized =
        typeof locale.maximize === 'function' ? locale.maximize() : locale;
      const region = maximized.region?.toUpperCase();
      if (region && COUNTRY_CODES.has(region)) return region;
    } catch {
      // Malformed language tag — skip.
    }
  }

  return fallback;
}

export function getDefaultRegionForCountry(countryCode: string): string {
  if (UK_IE_COUNTRIES.has(countryCode)) return 'aws-eu-west-2';
  if (EU_COUNTRIES.has(countryCode)) return 'aws-eu-central-1';
  if (US_CA_COUNTRIES.has(countryCode)) return 'aws-us-east-1';
  if (APAC_OCEANIA_COUNTRIES.has(countryCode)) return 'aws-ap-southeast-2';
  if (APAC_SOUTHEAST_COUNTRIES.has(countryCode)) return 'aws-ap-southeast-1';
  // Default to EU for Africa, Middle East, South America, and unknown
  return 'aws-eu-central-1';
}

export const DEFAULT_ONBOARDING_DATA: OnboardingFormData = {
  firstName: '',
  lastName: '',
  productUpdates: true,
  organizationName: '',
  organizationType: '',
  country: '',
  organizationSize: '',
  referralSource: '',
  region: 'aws-eu-central-1',
  role: '',
};

export interface OnboardingStatus {
  completed: boolean;
  hasOrganization: boolean;
}

export interface DatabaseStatus {
  provisioned: boolean;
  migrated: boolean;
}

export interface UserAndOrgInfo {
  user: {
    firstName: string;
    lastName: string;
    email: string;
    imageUrl?: string;
  };
  organization: {
    id: string;
    name: string;
  } | null;
}
