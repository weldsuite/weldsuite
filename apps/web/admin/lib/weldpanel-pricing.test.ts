import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PANEL_PRICING,
  MAX_CREDITS_PER_BLOCK,
  WELDPANEL_PRICING_KEY,
  exampleCharge,
  parsePricingInput,
  parseRateInput,
  resolveStoredPricing,
} from './weldpanel-pricing';

describe('WeldPanel pricing', () => {
  it('uses the key panel-api reads', () => {
    expect(WELDPANEL_PRICING_KEY).toBe('weldpanel.pricing');
  });

  it('accepts whole positive credits up to the maximum', () => {
    expect(parsePricingInput({ eventsCreditsPer10k: '12', recordingsCreditsPer100: ' 30 ' })).toEqual({
      ok: true,
      data: { eventsCreditsPer10k: 12, recordingsCreditsPer100: 30 },
    });
    expect(parsePricingInput({ eventsCreditsPer10k: String(MAX_CREDITS_PER_BLOCK), recordingsCreditsPer100: '1' }).ok).toBe(true);
  });

  it('names the first field that fails and why', () => {
    expect(parsePricingInput({ eventsCreditsPer10k: '', recordingsCreditsPer100: '5' })).toEqual({ ok: false, field: 'eventsCreditsPer10k', code: 'invalid' });
    expect(parsePricingInput({ eventsCreditsPer10k: '5', recordingsCreditsPer100: '0' })).toEqual({ ok: false, field: 'recordingsCreditsPer100', code: 'invalid' });
    expect(parsePricingInput({ eventsCreditsPer10k: '2.5', recordingsCreditsPer100: '5' })).toEqual({ ok: false, field: 'eventsCreditsPer10k', code: 'invalid' });
    expect(parsePricingInput({ eventsCreditsPer10k: String(MAX_CREDITS_PER_BLOCK + 1), recordingsCreditsPer100: '5' })).toEqual({ ok: false, field: 'eventsCreditsPer10k', code: 'out_of_range' });
    expect(parseRateInput('abc')).toBeNaN();
  });

  it('resolves a stored value the way panel-api does: field by field, defaults for the rest', () => {
    expect(resolveStoredPricing(null)).toEqual(DEFAULT_PANEL_PRICING);
    expect(resolveStoredPricing({ eventsCreditsPer10k: 7 })).toEqual({ eventsCreditsPer10k: 7, recordingsCreditsPer100: DEFAULT_PANEL_PRICING.recordingsCreditsPer100 });
    expect(resolveStoredPricing({ eventsCreditsPer10k: -1, recordingsCreditsPer100: 4 })).toEqual({ eventsCreditsPer10k: DEFAULT_PANEL_PRICING.eventsCreditsPer10k, recordingsCreditsPer100: 4 });
  });

  it('prices the example month in whole blocks', () => {
    expect(exampleCharge({ eventsCreditsPer10k: 10, recordingsCreditsPer100: 20 })).toEqual({ events: 100, recordings: 200, total: 300 });
  });
});
