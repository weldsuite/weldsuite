import { describe, expect, it } from 'vitest';
import type { PartnerContractView } from '@weldsuite/app-api-client/schemas/partners';
import {
  bpsToPercent,
  canRunStatement,
  canVoidStatement,
  changedProfileFields,
  contractFormFromView,
  currentContract,
  dateToIso,
  defaultContractForm,
  defaultLicenceForm,
  diffTerritories,
  licenceFormFromSnapshot,
  normalizeCountries,
  parseContractForm,
  parseLicenceForm,
  parseProfileForm,
  paymentOverview,
  pauseUntilIso,
  percentToBps,
  periodOf,
  previousPeriodOf,
  profileFormFromRecord,
  territoryConflictCountries,
  type AdminPartnerRecord,
} from './partners';

const contractView = (overrides: Partial<PartnerContractView> = {}): PartnerContractView => ({
  id: 'ptc_1',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
  currency: 'USD',
  revenueShareBps: 7500,
  baseMinimum: '50.00',
  includedCredits: 2000,
  creditFloorPrice: '0.004',
  extraCreditPrice: '0.01',
  allowedFeaturePlanIds: ['business'],
  paymentTermsDays: 30,
  pastDueAfterDays: 14,
  readOnlyAfterDays: 30,
  ...overrides,
});

describe('percentToBps / bpsToPercent', () => {
  it('converts a percentage to basis points', () => {
    expect(percentToBps('75')).toBe(7500);
    expect(percentToBps('72.5')).toBe(7250);
    expect(percentToBps('72,25')).toBe(7225);
    expect(percentToBps('0')).toBe(0);
    expect(percentToBps('100')).toBe(10_000);
  });

  it('rejects values outside 0-100 or with too many decimals', () => {
    for (const bad of ['', 'abc', '100.01', '101', '-5', '12.345']) expect(percentToBps(bad)).toBeNull();
  });

  it('round-trips', () => {
    for (const bps of [0, 1, 250, 7250, 7500, 7525, 10_000]) expect(percentToBps(bpsToPercent(bps))).toBe(bps);
    expect(bpsToPercent(7500)).toBe('75');
    expect(bpsToPercent(7250)).toBe('72.5');
    expect(bpsToPercent(7205)).toBe('72.05');
  });
});

describe('dateToIso', () => {
  it('reads a calendar date as 00:00 UTC', () => {
    expect(dateToIso('2026-10-01')).toBe('2026-10-01T00:00:00.000Z');
  });

  it('rejects impossible or malformed dates', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '01/10/2026', '', '2026-1-1']) expect(dateToIso(bad)).toBeNull();
  });
});

describe('parseContractForm', () => {
  const valid = () => ({ ...defaultContractForm(), baseMinimum: '50' });

  it('maps the form to the contract schema with the plan defaults', () => {
    const result = parseContractForm(valid());
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        currency: 'USD',
        revenueShareBps: 7500,
        baseMinimum: '50',
        includedCredits: 0,
        paymentTermsDays: 30,
        pastDueAfterDays: 14,
        readOnlyAfterDays: 30,
        allowedFeaturePlanIds: [],
      }),
    });
  });

  it('sends the effective date as an ISO timestamp', () => {
    const result = parseContractForm({ ...valid(), effectiveFrom: '2026-11-01' });
    expect(result.ok && result.value.effectiveFrom).toBe('2026-11-01T00:00:00.000Z');
  });

  it('names the offending field', () => {
    const noMinimum = parseContractForm({ ...valid(), baseMinimum: '' });
    expect(noMinimum.ok).toBe(false);
    expect(!noMinimum.ok && noMinimum.error).toContain('baseMinimum');

    const badShare = parseContractForm({ ...valid(), revenueSharePercent: '150' });
    expect(!badShare.ok && badShare.error).toContain('revenueSharePercent');

    const badDate = parseContractForm({ ...valid(), effectiveFrom: '2026-02-31' });
    expect(!badDate.ok && badDate.error).toContain('effectiveFrom');
  });

  it('requires read-only to come after past due', () => {
    const result = parseContractForm({ ...valid(), pastDueAfterDays: '30', readOnlyAfterDays: '30' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('readOnlyAfterDays');
  });

  it('rejects a non-numeric day count instead of coercing it', () => {
    const result = parseContractForm({ ...valid(), paymentTermsDays: 'thirty' });
    expect(result.ok).toBe(false);
  });

  it('starts a new contract from the one in force', () => {
    const form = contractFormFromView(contractView({ revenueShareBps: 7250 }));
    expect(form.revenueSharePercent).toBe('72.5');
    expect(form.effectiveFrom).toBe('');
    expect(form.allowedFeaturePlanIds).toEqual(['business']);
    expect(parseContractForm(form).ok).toBe(true);
  });
});

describe('parseProfileForm', () => {
  const record: AdminPartnerRecord = {
    id: 'ptr_1',
    name: 'Acme Resell',
    legalName: null,
    country: 'br',
    taxId: null,
    billingEmail: 'ap@acme.test',
    supportEmail: 'help@acme.test',
    supportUrl: null,
    websiteUrl: 'https://acme.test',
    logoUrl: null,
    stripeCustomerId: null,
    status: 'active',
    statusChangedAt: null,
    dunningPausedUntil: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('upper-cases the country and turns blanks into nulls', () => {
    const result = parseProfileForm(profileFormFromRecord(record));
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({ country: 'BR', legalName: null, taxId: null, billingEmail: 'ap@acme.test' }),
    });
  });

  it('rejects a bad email or url', () => {
    expect(parseProfileForm({ ...profileFormFromRecord(record), billingEmail: 'nope' }).ok).toBe(false);
    expect(parseProfileForm({ ...profileFormFromRecord(record), websiteUrl: 'acme.test' }).ok).toBe(false);
  });

  it('sends only what changed, with a cleared field as null', () => {
    const saved = profileFormFromRecord(record);
    expect(changedProfileFields(saved, saved)).toEqual({});
    expect(changedProfileFields({ ...saved, name: 'Acme Resell BV', supportEmail: '' }, saved)).toEqual({
      name: 'Acme Resell BV',
      supportEmail: null,
    });
  });
});

describe('parseLicenceForm', () => {
  const valid = () => ({ ...defaultLicenceForm(), allowedApps: ['welddesk', 'weldcrm'], monthlyCredits: '3000', amount: '199' });

  it('maps a flat licence', () => {
    expect(parseLicenceForm(valid())).toEqual({
      ok: true,
      value: {
        allowedApps: ['welddesk', 'weldcrm'],
        monthlyCredits: 3000,
        creditRolloverCap: 0,
        maxSeats: null,
        featurePlanId: null,
        storageGb: null,
        resalePricing: { model: 'flat', amount: '199' },
      },
    });
  });

  it('maps a per-seat licence with a minimum, seat cap and feature plan', () => {
    const result = parseLicenceForm({
      ...valid(),
      pricingModel: 'per_seat',
      amount: '12.50',
      minSeats: '5',
      maxSeats: '40',
      featurePlanId: 'business',
    });
    expect(result.ok && result.value).toMatchObject({
      maxSeats: 40,
      featurePlanId: 'business',
      resalePricing: { model: 'per_seat', amount: '12.50', minSeats: 5 },
    });
  });

  it('drops a minimum left over from a per-seat form once the model is flat', () => {
    const result = parseLicenceForm({ ...valid(), pricingModel: 'flat', minSeats: '5' });
    expect(result.ok && result.value.resalePricing).toEqual({ model: 'flat', amount: '199' });
  });

  it('de-duplicates apps', () => {
    const result = parseLicenceForm({ ...valid(), allowedApps: ['welddesk', 'welddesk'] });
    expect(result.ok && result.value.allowedApps).toEqual(['welddesk']);
  });

  it('requires a price with at most two decimals', () => {
    expect(parseLicenceForm({ ...valid(), amount: '' }).ok).toBe(false);
    expect(parseLicenceForm({ ...valid(), amount: '10.999' }).ok).toBe(false);
  });

  it('rejects non-numeric credits and seat counts', () => {
    expect(parseLicenceForm({ ...valid(), monthlyCredits: '3k' }).ok).toBe(false);
    expect(parseLicenceForm({ ...valid(), maxSeats: 'ten' }).ok).toBe(false);
  });

  it('round-trips through the form', () => {
    const parsed = parseLicenceForm({ ...valid(), pricingModel: 'per_seat', amount: '12', minSeats: '3', maxSeats: '9' });
    if (!parsed.ok) throw new Error(parsed.error);
    const form = licenceFormFromSnapshot({ ...parsed.value, status: 'active', packageId: null });
    expect(parseLicenceForm(form)).toEqual(parsed);
  });
});

describe('territories', () => {
  it('normalises codes: upper-case, unique, sorted, ISO-2 only', () => {
    expect(normalizeCountries(['br', 'BR', ' us ', 'USA', '', 'ar'])).toEqual(['AR', 'BR', 'US']);
  });

  it('diffs the saved list against the edited one', () => {
    expect(diffTerritories(['AR', 'BR', 'US'], ['BR', 'CA', 'US'])).toEqual({ added: ['CA'], removed: ['AR'] });
    expect(diffTerritories(['AR'], ['AR'])).toEqual({ added: [], removed: [] });
  });

  it('reads the countries out of a TERRITORY_CONFLICT payload', () => {
    expect(territoryConflictCountries({ countries: ['br', 'AR'] })).toEqual(['AR', 'BR']);
    expect(territoryConflictCountries({ countries: [{ country: 'mx', partnerId: 'ptr_2' }] })).toEqual(['MX']);
    expect(territoryConflictCountries(undefined)).toEqual([]);
    expect(territoryConflictCountries({ countries: 'BR' })).toEqual([]);
  });
});

describe('currentContract', () => {
  it('prefers the open-ended contract, then the latest', () => {
    const old = contractView({ id: 'old', effectiveFrom: '2025-01-01T00:00:00.000Z', effectiveTo: '2026-01-01T00:00:00.000Z' });
    const open = contractView({ id: 'open' });
    expect(currentContract([old, open])?.id).toBe('open');
    expect(currentContract([old])?.id).toBe('old');
    expect(currentContract([])).toBeNull();
  });
});

describe('paymentOverview', () => {
  const now = new Date('2026-10-20T12:00:00.000Z');
  const statement = (id: string, dueAt: string | null, status: 'invoiced' | 'paid' | 'draft' = 'invoiced') => ({
    id,
    status,
    periodStart: '2026-09-01T00:00:00.000Z',
    dueAt,
  });
  const contract = { pastDueAfterDays: 14, readOnlyAfterDays: 30 };

  it('is current with nothing overdue', () => {
    const result = paymentOverview({ statements: [], contract, dunningPausedUntil: null, now });
    expect(result).toEqual({ overdue: [], maxDaysOverdue: 0, stage: 'current', paused: false });
  });

  it('ignores paid, draft and not-yet-due statements', () => {
    const result = paymentOverview({
      statements: [statement('a', '2026-09-01T00:00:00.000Z', 'paid'), statement('b', '2026-09-01T00:00:00.000Z', 'draft'), statement('c', '2026-11-01T00:00:00.000Z')],
      contract,
      dunningPausedUntil: null,
      now,
    });
    expect(result.overdue).toEqual([]);
    expect(result.stage).toBe('current');
  });

  it('takes the worst stage across overdue statements', () => {
    const result = paymentOverview({
      statements: [statement('late', '2026-10-01T00:00:00.000Z'), statement('very-late', '2026-09-10T00:00:00.000Z')],
      contract,
      dunningPausedUntil: null,
      now,
    });
    expect(result.overdue.map((o) => [o.statementId, o.daysOverdue, o.stage])).toEqual([
      ['very-late', 40, 'suspended'],
      ['late', 19, 'past_due'],
    ]);
    expect(result.stage).toBe('suspended');
    expect(result.maxDaysOverdue).toBe(40);
  });

  it('holds everything at current while the clock is paused, and counts a lapsed pause as running', () => {
    const statements = [statement('x', '2026-09-10T00:00:00.000Z')];
    const paused = paymentOverview({ statements, contract, dunningPausedUntil: '2026-10-30T00:00:00.000Z', now });
    expect(paused.paused).toBe(true);
    expect(paused.stage).toBe('current');
    expect(paused.overdue[0]?.daysOverdue).toBe(40);

    const lapsed = paymentOverview({ statements, contract, dunningPausedUntil: '2026-10-01T00:00:00.000Z', now });
    expect(lapsed.paused).toBe(false);
    expect(lapsed.stage).toBe('suspended');
  });

  it('falls back to the default thresholds without a contract', () => {
    const result = paymentOverview({
      statements: [statement('x', '2026-10-01T00:00:00.000Z')],
      contract: null,
      dunningPausedUntil: null,
      now,
    });
    expect(result.stage).toBe('past_due');
  });
});

describe('pauseUntilIso', () => {
  it('ends the pause at the last moment of the chosen UTC day', () => {
    expect(pauseUntilIso(14, new Date('2026-10-20T15:30:00.000Z'))).toBe('2026-11-03T23:59:59.999Z');
    expect(pauseUntilIso(7, new Date('2026-12-28T00:00:00.000Z'))).toBe('2027-01-04T23:59:59.999Z');
  });
});

describe('statement periods and actions', () => {
  it('names the UTC month and the month before', () => {
    expect(periodOf(new Date('2026-10-31T23:59:59.000Z'))).toBe('2026-10');
    expect(previousPeriodOf(new Date('2026-10-10T00:00:00.000Z'))).toBe('2026-09');
    expect(previousPeriodOf(new Date('2026-01-05T00:00:00.000Z'))).toBe('2025-12');
  });

  it('allows run on draft/final/preview and void on anything not paid or void', () => {
    expect(['draft', 'final', 'preview', 'invoiced', 'paid', 'void'].map((s) => canRunStatement(s as never))).toEqual([true, true, true, false, false, false]);
    expect(['draft', 'final', 'preview', 'invoiced', 'paid', 'void'].map((s) => canVoidStatement(s as never))).toEqual([true, true, false, true, false, false]);
  });
});
