import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import type { SalesTaxZone } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import {
  combinedRate,
  emptyZoneForm,
  formatCombinedRate,
  makeZoneSchema,
  toCreateZoneInput,
  toUpdateZoneInput,
  zipProblemsText,
  zoneToForm,
} from './zone-model';

const setup = en.weldbooksUs.salesTax.setup;
const format = (template: string, values: Record<string, unknown>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''));
const schema = makeZoneSchema(setup.validation, setup.zones.problems, format);

function messages(values: ReturnType<typeof emptyZoneForm>): Record<string, string> {
  const result = schema.safeParse(values);
  if (result.success) return {};
  return Object.fromEntries(result.error.issues.map((i) => [String(i.path[0]), i.message]));
}

const austin = { ...emptyZoneForm(), name: 'Austin', jurisdictionIds: ['stj_1', 'stj_2'], zipText: '78701, 78702, 78710-78799' };

describe('zone payload', () => {
  it('turns the ZIP text into the entries the API stores', () => {
    expect(toCreateZoneInput('sta_1', austin)).toEqual({
      agencyId: 'sta_1',
      name: 'Austin',
      jurisdictionIds: ['stj_1', 'stj_2'],
      postalCodes: ['78701', '78702', { from: '78710', to: '78799' }],
      isOrigin: false,
      priority: 100,
    });
  });

  it('has the same fields for an update, without the agency', () => {
    const { agencyId, ...create } = toCreateZoneInput('sta_1', austin);
    expect(agencyId).toBe('sta_1');
    expect(toUpdateZoneInput(austin)).toEqual(create);
  });

  it('round-trips a zone through the form', () => {
    const zone = {
      id: 'stz_1',
      agencyId: 'sta_1',
      stateCode: 'TX',
      name: 'Austin',
      jurisdictionIds: ['stj_1'],
      postalCodes: ['78701', { from: '78710', to: '78799' }],
      isOrigin: true,
      priority: 10,
      jurisdictions: [],
      combinedRate: 8.25,
    } satisfies SalesTaxZone;
    const form = zoneToForm(zone);
    expect(form).toEqual({ name: 'Austin', jurisdictionIds: ['stj_1'], zipText: '78701, 78710-78799', isOrigin: true, priority: '10' });
    expect(toUpdateZoneInput(form).postalCodes).toEqual(zone.postalCodes);
  });
});

describe('zone validation', () => {
  it('accepts a named zone with jurisdictions and ZIP codes', () => {
    expect(messages(austin)).toEqual({});
  });

  it('needs a name and at least one jurisdiction', () => {
    expect(messages({ ...austin, name: ' ', jurisdictionIds: [] })).toMatchObject({
      name: setup.validation.required,
      jurisdictionIds: setup.validation.zoneJurisdictions,
    });
  });

  it('needs ZIP codes unless the zone is the own location', () => {
    expect(messages({ ...austin, zipText: '' }).zipText).toBe(setup.validation.zoneZips);
    expect(messages({ ...austin, zipText: '', isOrigin: true })).toEqual({});
  });

  it('names the ZIP codes it could not read', () => {
    const text = messages({ ...austin, zipText: '78701, 7870, 78799-78710' }).zipText;
    expect(text).toContain('"7870" is not a ZIP code or range');
    expect(text).toContain('"78799-78710" runs backwards');
  });

  it('wants a whole-number priority up to 10,000', () => {
    expect(messages({ ...austin, priority: 'x' }).priority).toBe(setup.validation.priority);
    expect(messages({ ...austin, priority: '10001' }).priority).toBe(setup.validation.priority);
    expect(messages({ ...austin, priority: '0' })).toEqual({});
  });

  it('describes the problems of a typed list in one line', () => {
    expect(zipProblemsText('78701-1234, abc', setup.zones.problems, format)).toBe(
      '"78701-1234" is a ZIP+4. Use the five-digit ZIP code; "abc" is not a ZIP code or range',
    );
    expect(zipProblemsText('78701', setup.zones.problems, format)).toBe('');
  });
});

describe('combined rate', () => {
  const jurisdictions = [
    { id: 'a', currentRate: 6.25 },
    { id: 'b', currentRate: 1 },
    { id: 'c', currentRate: 1 },
    { id: 'd', currentRate: null },
  ];

  it('adds the rates in force today of the chosen jurisdictions', () => {
    expect(combinedRate(jurisdictions, ['a', 'b', 'c'])).toBe(8.25);
    expect(combinedRate(jurisdictions, ['a', 'd'])).toBe(6.25);
    expect(combinedRate(jurisdictions, [])).toBe(0);
  });

  it('does not accumulate floating point error', () => {
    expect(
      combinedRate(
        [
          { id: 'a', currentRate: 0.1 },
          { id: 'b', currentRate: 0.2 },
        ],
        ['a', 'b'],
      ),
    ).toBe(0.3);
  });

  it('is shown as a percentage', () => {
    expect(formatCombinedRate(8.25)).toBe('8.25%');
    expect(formatCombinedRate(0)).toBe('0%');
  });
});
