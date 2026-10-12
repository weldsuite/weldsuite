import { describe, expect, it } from 'vitest';
import type { LicenceSnapshot } from '@weldsuite/app-api-client/schemas/partners';
import { draftFromLicence, draftShortfall, emptyDraft, parseDraft, previewDraft } from './licence-draft';

const contract = {
  revenueShareBps: 7500,
  baseMinimum: '50.00',
  includedSeats: 0,
  seatFloorPrice: '0',
  includedCredits: 2000,
  creditFloorPrice: '0.004',
};

/** $100 a month including 5 seats, $10 for each seat above that. */
const seated = { ...contract, baseMinimum: '100.00', includedSeats: 5, seatFloorPrice: '10.00' };

describe('parseDraft', () => {
  it('turns the form strings into the request body the server validates', () => {
    const parsed = parseDraft({
      ...emptyDraft(),
      allowedApps: ['welddesk', 'weldcrm', 'welddesk'],
      monthlyCredits: '3000',
      maxSeats: '10',
      featurePlanId: 'plan_business',
      pricingModel: 'per_seat',
      amount: '12.50',
      minSeats: '3',
      reason: ' raised the allowance ',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      allowedApps: ['welddesk', 'weldcrm'], // de-duplicated by the shared schema
      monthlyCredits: 3000,
      creditRolloverCap: 0,
      maxSeats: 10,
      storageGb: null,
      featurePlanId: 'plan_business',
      resalePricing: { model: 'per_seat', amount: '12.50', minSeats: 3 },
      reason: 'raised the allowance',
    });
  });

  it('treats an empty seat limit as unlimited', () => {
    const parsed = parseDraft({ ...emptyDraft(), amount: '199' });
    expect(parsed.ok && parsed.value.maxSeats).toBeNull();
  });

  it('reports each bad field, keyed to the message to show', () => {
    const parsed = parseDraft({
      ...emptyDraft(),
      monthlyCredits: '12x',
      maxSeats: '0',
      amount: '1.234',
      pricingModel: 'per_seat',
      minSeats: 'abc',
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual({
      monthlyCredits: 'invalidCredits',
      maxSeats: 'invalidSeats',
      amount: 'invalidAmount',
      minSeats: 'invalidSeats',
    });
  });

  it('requires a price', () => {
    const parsed = parseDraft({ ...emptyDraft(), amount: '' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.amount).toBe('invalidAmount');
  });

  it('refuses a price below the minimum when given the contract', () => {
    const below = parseDraft({ ...emptyDraft(), amount: '120', maxSeats: '10' }, seated);
    expect(below).toEqual({ ok: false, errors: { amount: 'belowMinimum' } });
    expect(parseDraft({ ...emptyDraft(), amount: '150', maxSeats: '10' }, seated).ok).toBe(true);
    // Without the contract only the shape is checked.
    expect(parseDraft({ ...emptyDraft(), amount: '120', maxSeats: '10' }).ok).toBe(true);
  });

  it('points a flat price that needs a seat limit at the seat limit', () => {
    expect(parseDraft({ ...emptyDraft(), amount: '500' }, seated)).toEqual({ ok: false, errors: { maxSeats: 'needsSeatLimit' } });
  });
});

describe('draftShortfall', () => {
  it('says where the price falls short, and nothing while the draft is half typed', () => {
    expect(draftShortfall(seated, { ...emptyDraft(), amount: '120', maxSeats: '10' })).toEqual({
      reason: 'below_minimum',
      seats: 10,
      minimum: 15000,
      price: 12000,
    });
    expect(draftShortfall(seated, { ...emptyDraft(), amount: '12.' })).toBeNull();
    expect(draftShortfall(null, { ...emptyDraft(), amount: '1' })).toBeNull();
  });
});

describe('draftFromLicence', () => {
  it('round-trips a stored licence through the form and back', () => {
    const licence: LicenceSnapshot = {
      status: 'active',
      packageId: 'plp_1',
      allowedApps: ['welddesk'],
      monthlyCredits: 5000,
      creditRolloverCap: 1000,
      maxSeats: null,
      featurePlanId: null,
      storageGb: 50,
      resalePricing: { model: 'flat', amount: '199.00' },
    };
    const parsed = parseDraft(draftFromLicence(licence));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      packageId: 'plp_1',
      allowedApps: ['welddesk'],
      monthlyCredits: 5000,
      creditRolloverCap: 1000,
      storageGb: 50,
      resalePricing: { model: 'flat', amount: '199.00' },
    });
  });
});

describe('previewDraft', () => {
  it('prices the draft with the contract, as the statement run does', () => {
    const price = previewDraft(contract, { ...emptyDraft(), monthlyCredits: '2000', amount: '400' }, 1);
    expect(price).toMatchObject({ resale: 40000, share: 30000, floor: 5000, due: 30000, margin: 10000, basis: 'share' });
  });

  it('is null while the amount or credits are not valid numbers', () => {
    expect(previewDraft(contract, { ...emptyDraft(), amount: '' }, 1)).toBeNull();
    expect(previewDraft(contract, { ...emptyDraft(), amount: '12.345' }, 1)).toBeNull();
    expect(previewDraft(contract, { ...emptyDraft(), amount: '10', monthlyCredits: '' }, 1)).toBeNull();
    expect(previewDraft(null, { ...emptyDraft(), amount: '10' }, 1)).toBeNull();
  });
});
