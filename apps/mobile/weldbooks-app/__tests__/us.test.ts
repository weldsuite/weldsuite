import {
  EMPTY_ADDRESS,
  FALLBACK_US_ENTITY_TYPES,
  US_STATES,
  US_STATE_OPTIONS,
  WELD_TAX_CODES,
  addressLines,
  cityLine,
  defaultClassificationOf,
  einProblem,
  formatEinInput,
  formatZipInput,
  isAddressBlank,
  isUsAddressTaxable,
  isUsStateCode,
  isWeldTaxCode,
  normalizeEin,
  normalizeZip,
  toAddressDraft,
  toApiAddress,
  toUsStateCode,
  usAddressProblems,
  usEntityTypes,
  validClassification,
} from '@/lib/us';
import { en } from '@/lib/i18n/locales/en';
import { nl } from '@/lib/i18n/locales/nl';

describe('states', () => {
  it('lists the 50 states, DC and the five territories by USPS code', () => {
    expect(US_STATES).toHaveLength(56);
    expect(new Set(US_STATES.map((s) => s.code)).size).toBe(56);
    for (const code of ['CA', 'TX', 'NY', 'DC', 'PR', 'GU', 'VI']) expect(isUsStateCode(code)).toBe(true);
  });

  it('refuses codes that are not states', () => {
    expect(isUsStateCode('XX')).toBe(false);
    expect(isUsStateCode('')).toBe(false);
    expect(isUsStateCode(null)).toBe(false);
    // Canadian provinces share letters with nothing here.
    expect(isUsStateCode('ON')).toBe(false);
  });

  it('turns a typed name or code into the USPS code', () => {
    expect(toUsStateCode('ca')).toBe('CA');
    expect(toUsStateCode(' California ')).toBe('CA');
    expect(toUsStateCode('new york')).toBe('NY');
    expect(toUsStateCode('District of Columbia')).toBe('DC');
  });

  it('keeps what it cannot map, so nothing typed is lost', () => {
    expect(toUsStateCode('Ontario')).toBe('Ontario');
    expect(toUsStateCode('')).toBe('');
    expect(toUsStateCode(undefined)).toBe('');
  });

  it('offers a picker option per state', () => {
    expect(US_STATE_OPTIONS).toHaveLength(US_STATES.length);
    expect(US_STATE_OPTIONS.find((o) => o.value === 'TX')?.label).toBe('Texas (TX)');
  });
});

describe('ZIP codes', () => {
  it('accepts ZIP and ZIP+4, with or without the hyphen', () => {
    expect(normalizeZip('62704')).toBe('62704');
    expect(normalizeZip(' 62704-1234 ')).toBe('62704-1234');
    expect(normalizeZip('627041234')).toBe('62704-1234');
  });

  it('keeps a leading zero (ZIP codes are text)', () => {
    expect(normalizeZip('02134')).toBe('02134');
    expect(normalizeZip('00501')).toBe('00501');
  });

  it('refuses what is not a ZIP', () => {
    expect(normalizeZip('6270')).toBeNull();
    expect(normalizeZip('62704-12')).toBeNull();
    expect(normalizeZip('ABCDE')).toBeNull();
    expect(normalizeZip('00000')).toBeNull();
    expect(normalizeZip('')).toBeNull();
    expect(normalizeZip(null)).toBeNull();
  });

  it('formats a ZIP as it is typed', () => {
    expect(formatZipInput('62704')).toBe('62704');
    expect(formatZipInput('627041')).toBe('62704-1');
    expect(formatZipInput('6270-41234999')).toBe('62704-1234');
    expect(formatZipInput('ab12c')).toBe('12');
  });
});

describe('EIN', () => {
  it('formats as it is typed', () => {
    expect(formatEinInput('12')).toBe('12');
    expect(formatEinInput('123')).toBe('12-3');
    expect(formatEinInput('123456789')).toBe('12-3456789');
    expect(formatEinInput('12-34567890123')).toBe('12-3456789');
  });

  it('accepts a valid EIN with or without the hyphen, and blank', () => {
    expect(einProblem('12-3456789')).toBeNull();
    expect(einProblem('123456789')).toBeNull();
    expect(einProblem('')).toBeNull();
    expect(einProblem('  ')).toBeNull();
  });

  it('rejects the wrong shape', () => {
    expect(einProblem('12-345678')).toBe('format');
    expect(einProblem('1234567890')).toBe('format');
    expect(einProblem('ab-cdefghi')).toBe('format');
  });

  it('rejects a prefix the IRS does not assign', () => {
    for (const prefix of ['00', '07', '08', '09', '17', '18', '19', '28', '29', '49', '69', '70', '78', '79', '89', '96', '97']) {
      expect(einProblem(`${prefix}-1234567`)).toBe('prefix');
    }
    for (const prefix of ['01', '10', '20', '30', '50', '71', '80', '90', '98', '99']) {
      expect(einProblem(`${prefix}-1234567`)).toBeNull();
    }
  });

  it('normalises to XX-XXXXXXX', () => {
    expect(normalizeEin('123456789')).toBe('12-3456789');
    expect(normalizeEin(' 12-3456789 ')).toBe('12-3456789');
    expect(normalizeEin('123')).toBe('123');
  });
});

describe('address drafts', () => {
  const full = { line1: '1 Main St', line2: 'Suite 4', city: 'Springfield', state: 'IL', postalCode: '62704' };

  it('starts blank', () => {
    expect(isAddressBlank({ ...EMPTY_ADDRESS })).toBe(true);
    expect(isAddressBlank({ ...EMPTY_ADDRESS, city: ' ' })).toBe(true);
    expect(isAddressBlank({ ...EMPTY_ADDRESS, city: 'Austin' })).toBe(false);
  });

  it('reads a stored address, turning a state name into its code', () => {
    expect(toAddressDraft({ line1: '1 Main St', city: 'Austin', state: 'Texas', postalCode: '78701' })).toEqual({
      line1: '1 Main St',
      line2: '',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
    });
    expect(toAddressDraft(null)).toEqual(EMPTY_ADDRESS);
  });

  it('is taxable with a real state and a ZIP, whatever else is missing', () => {
    expect(isUsAddressTaxable({ state: 'TX', postalCode: '78701' })).toBe(true);
    expect(isUsAddressTaxable({ state: 'TX', postalCode: '' })).toBe(false);
    expect(isUsAddressTaxable({ state: '', postalCode: '78701' })).toBe(false);
    expect(isUsAddressTaxable({ state: 'Ontario', postalCode: '78701' })).toBe(false);
    expect(isUsAddressTaxable({ state: 'TX', postalCode: '7870' })).toBe(false);
  });

  it('asks for state and ZIP when told to, and only when the address is started otherwise', () => {
    expect(usAddressProblems({ ...EMPTY_ADDRESS })).toEqual({});
    expect(usAddressProblems({ ...EMPTY_ADDRESS }, { requireStateAndZip: true })).toEqual({
      state: 'required',
      postalCode: 'required',
    });
    expect(usAddressProblems({ ...EMPTY_ADDRESS, city: 'Austin' })).toEqual({
      state: 'required',
      postalCode: 'required',
    });
    expect(usAddressProblems(full)).toEqual({});
  });

  it('names what is invalid', () => {
    expect(usAddressProblems({ ...full, state: 'ZZ' })).toEqual({ state: 'invalid' });
    expect(usAddressProblems({ ...full, postalCode: '123' })).toEqual({ postalCode: 'invalid' });
  });

  it('sends the address the way the API takes it: trimmed, US, blank parts left out', () => {
    expect(toApiAddress({ line1: ' 1 Main St ', line2: '', city: ' Austin', state: 'texas', postalCode: '787011234' })).toEqual({
      country: 'US',
      line1: '1 Main St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701-1234',
    });
  });

  it('sends nothing for a blank address', () => {
    expect(toApiAddress({ ...EMPTY_ADDRESS })).toBeNull();
  });

  it('prints an address in lines', () => {
    expect(addressLines({ line1: '1 Main St', line2: 'Suite 4', city: 'Springfield', state: 'IL', postalCode: '62704' })).toEqual([
      '1 Main St',
      'Suite 4',
      'Springfield, IL 62704',
    ]);
    expect(addressLines({ state: 'TX', postalCode: '78701' })).toEqual(['TX 78701']);
    expect(addressLines(null)).toEqual([]);
    expect(cityLine({ city: 'Austin' })).toBe('Austin');
    expect(cityLine(undefined)).toBe('');
  });
});

describe('tax codes', () => {
  it('has the twelve product tax codes books-api accepts', () => {
    expect([...WELD_TAX_CODES]).toEqual([
      'general',
      'saas',
      'digital_goods',
      'services',
      'professional_services',
      'shipping',
      'handling',
      'food_grocery',
      'prepared_food',
      'clothing',
      'prescription_drugs',
      'non_taxable',
    ]);
    expect(isWeldTaxCode('saas')).toBe(true);
    expect(isWeldTaxCode('txcd_20030000')).toBe(false);
  });

  it('has a label for every code in both languages', () => {
    for (const catalog of [en.salesTax.codes, nl.salesTax.codes]) {
      for (const code of WELD_TAX_CODES) expect(catalog[code]).toBeTruthy();
    }
  });
});

describe('legal forms', () => {
  it('knows which tax classifications each form may elect', () => {
    const llc = FALLBACK_US_ENTITY_TYPES.find((t) => t.type === 'single_member_llc');

    expect(llc?.classifications.map((c) => c.value)).toEqual(['disregarded', 's_corp', 'c_corp']);
    expect(llc?.defaultClassification).toBe('disregarded');
    expect(llc?.classifications[1]).toMatchObject({ form: 'f1120s', formLabel: 'Form 1120-S' });
    expect(FALLBACK_US_ENTITY_TYPES.find((t) => t.type === 'multi_member_llc')?.defaultClassification).toBe('partnership');
    expect(FALLBACK_US_ENTITY_TYPES.find((t) => t.type === 'nonprofit')?.classifications).toHaveLength(1);
  });

  it('has a label for every form and classification in both languages', () => {
    for (const catalog of [en.entitySetup, nl.entitySetup]) {
      for (const type of FALLBACK_US_ENTITY_TYPES) {
        expect((catalog.entityTypes as Record<string, string>)[type.type]).toBeTruthy();
        for (const option of type.classifications) {
          expect((catalog.taxClassifications as Record<string, string>)[option.value]).toBeTruthy();
        }
      }
    }
  });

  it('prefers the list from the API and falls back to the built-in one', () => {
    const fromApi = [{ ...FALLBACK_US_ENTITY_TYPES[0], type: 'custom' }];

    expect(usEntityTypes(fromApi)).toBe(fromApi);
    expect(usEntityTypes(undefined)).toBe(FALLBACK_US_ENTITY_TYPES);
    expect(usEntityTypes([])).toBe(FALLBACK_US_ENTITY_TYPES);
  });

  it('keeps a classification the form allows and otherwise starts the form on its default', () => {
    const types = FALLBACK_US_ENTITY_TYPES;

    expect(validClassification(types, 'single_member_llc', 's_corp')).toBe('s_corp');
    // Switching from an LLC that elected S corporation status to a sole proprietorship.
    expect(validClassification(types, 'sole_proprietorship', 's_corp')).toBe('sole_proprietor');
    expect(validClassification(types, 'multi_member_llc', 'disregarded')).toBe('partnership');
    expect(validClassification(types, 'c_corp', null)).toBe('c_corp');
    expect(defaultClassificationOf(types, 'nonprofit')).toBe('exempt');
    expect(defaultClassificationOf(types, 'nope')).toBe('');
  });
});
