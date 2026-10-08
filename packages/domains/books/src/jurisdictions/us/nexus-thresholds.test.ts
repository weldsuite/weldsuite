import { describe, it, expect } from 'vitest';
import {
  NEXUS_RULES,
  getNexusRule,
  getNexusRuleHistory,
  nexusJurisdictionCodes,
  nexusMonitoredCodes,
  type NexusJurisdictionCode,
} from './nexus-thresholds';
import { US_STATES } from './states';

const TODAY = '2026-10-08';

function current(code: string) {
  const rule = getNexusRule(code, TODAY);
  if (!rule) throw new Error(`no rule for ${code}`);
  return rule;
}

describe('nexus thresholds coverage', () => {
  it('has a rule for every state, DC and Puerto Rico', () => {
    const codes = new Set(nexusJurisdictionCodes());
    for (const state of US_STATES) expect(codes.has(state.code), state.code).toBe(true);
    expect(codes.has('PR')).toBe(true);
    expect(codes.size).toBe(US_STATES.length + 1);
  });

  it('marks the four states without a sales tax and monitors the rest', () => {
    const none = nexusJurisdictionCodes().filter((code) => !current(code).hasSalesTax);
    expect(none).toEqual(['DE', 'MT', 'NH', 'OR']);
    for (const code of none) {
      const rule = current(code);
      expect(rule.salesThreshold).toBeNull();
      expect(rule.transactionThreshold).toBeNull();
    }
    const monitored = nexusMonitoredCodes();
    expect(monitored).toHaveLength(48);
    expect(monitored).toContain('AK');
    expect(monitored).toContain('PR');
    expect(monitored).not.toContain('OR');
  });

  it('keeps each state\'s versions in date order with distinct effective dates', () => {
    for (const code of nexusJurisdictionCodes()) {
      const dates = getNexusRuleHistory(code).map((rule) => rule.effectiveFrom);
      expect([...dates].sort(), code).toEqual(dates);
      expect(new Set(dates).size, code).toBe(dates.length);
    }
  });

  it('is consistent: a count threshold exists exactly when there is a count test', () => {
    for (const rule of NEXUS_RULES) {
      if (!rule.hasSalesTax) continue;
      expect(rule.transactionThreshold === null, `${rule.stateCode} ${rule.effectiveFrom}`).toBe(rule.test === 'none');
      expect(rule.salesThreshold).toBeGreaterThan(0);
      expect(rule.sourceUrl.startsWith('https://')).toBe(true);
      expect(rule.unverified).toContain('collection_start');
    }
  });
});

describe('nexus thresholds, October 2026 table', () => {
  it('uses $100,000 except the $250,000 and $500,000 states', () => {
    const higher: Record<string, number> = { AL: 250_000, MS: 250_000, CA: 500_000, TX: 500_000, NY: 500_000 };
    for (const code of nexusMonitoredCodes()) {
      expect(current(code).salesThreshold, code).toBe(higher[code] ?? 100_000);
    }
  });

  it('lists the states that still count transactions', () => {
    const states = nexusMonitoredCodes();
    const orStates = states.filter((code) => current(code).test === 'or');
    const andStates = states.filter((code) => current(code).test === 'and');
    expect(orStates).toEqual(['AR', 'DC', 'GA', 'HI', 'MD', 'MI', 'MN', 'NE', 'NJ', 'NV', 'OH', 'PR', 'RI', 'VA', 'VT', 'WV']);
    expect(andStates).toEqual(['CT', 'NY']);
    expect(current('NY').transactionThreshold).toBe(100);
    expect(current('CT').transactionThreshold).toBe(200);
  });

  it('requires "more than" in Mississippi and New York only', () => {
    const strict = nexusMonitoredCodes().filter((code) => current(code).comparison === 'gt');
    expect(strict).toEqual(['MS', 'NY']);
  });

  it('maps the measurement windows', () => {
    expect(current('AL').window).toBe('previous_calendar_year');
    expect(current('FL').window).toBe('previous_calendar_year');
    expect(current('MI').window).toBe('previous_calendar_year');
    expect(current('RI').window).toBe('previous_calendar_year');
    expect(current('CT').window).toBe('ct_october_september');
    expect(current('TX').window).toBe('rolling_12_months');
    expect(current('PA').window).toBe('rolling_12_months');
    expect(current('TN').window).toBe('rolling_12_months');
    expect(current('MS').window).toBe('rolling_12_months');
    expect(current('IL')).toMatchObject({ window: 'rolling_12_months', testedQuarterly: true });
    expect(current('MO')).toMatchObject({ window: 'rolling_12_months', testedQuarterly: true });
    expect(current('MN')).toMatchObject({ window: 'rolling_12_months', testedQuarterly: true });
    expect(current('VT')).toMatchObject({ window: 'rolling_four_quarters', quarterFirstMonth: 1 });
    expect(current('NY')).toMatchObject({ window: 'rolling_four_quarters', quarterFirstMonth: 3 });
    expect(current('CA').window).toBe('previous_or_current_calendar_year');
    expect(current('WA').window).toBe('previous_or_current_calendar_year');
  });

  it('maps what counts', () => {
    const base = (code: string) => current(code).base;
    expect(base('AL')).toBe('retail');
    expect(base('AR')).toBe('taxable');
    expect(base('FL')).toBe('taxable');
    expect(base('MO')).toBe('taxable');
    expect(base('NM')).toBe('taxable');
    expect(base('ND')).toBe('taxable');
    expect(base('OK')).toBe('taxable');
    expect(base('CA')).toBe('gross');
    expect(base('TX')).toBe('gross');
    expect(base('CO')).toBe('retail');
    expect(base('MN')).toBe('retail');
  });

  it('maps marketplace inclusion and flags the ones trackers disagree on', () => {
    expect(current('CA').marketplaceSalesCount).toBe(true);
    expect(current('TX').marketplaceSalesCount).toBe(true);
    expect(current('AL').marketplaceSalesCount).toBe(false);
    expect(current('IL').marketplaceSalesCount).toBe(false);
    expect(current('MA').marketplaceSalesCount).toBe(false);
    for (const code of ['WY', 'AZ', 'UT', 'MA']) expect(current(code).unverified, code).toContain('marketplace');
    expect(current('CA').unverified).not.toContain('marketplace');
  });
});

describe('nexus thresholds, versions by date', () => {
  it('dropped Illinois\' transaction test on 1 January 2026', () => {
    expect(getNexusRule('IL', '2025-12-31')).toMatchObject({ test: 'or', transactionThreshold: 200 });
    expect(getNexusRule('IL', '2026-01-01')).toMatchObject({ test: 'none', transactionThreshold: null });
  });

  it('dropped Kentucky\'s on 1 August 2026 and Utah\'s on 1 July 2025', () => {
    expect(getNexusRule('KY', '2026-07-31')?.test).toBe('or');
    expect(getNexusRule('KY', '2026-08-01')?.test).toBe('none');
    expect(getNexusRule('UT', '2025-06-30')?.test).toBe('or');
    expect(getNexusRule('UT', '2025-07-01')?.test).toBe('none');
  });

  it('dated the earlier removals', () => {
    expect(getNexusRule('SD', '2023-06-30')?.test).toBe('or');
    expect(getNexusRule('SD', '2023-07-01')?.test).toBe('none');
    expect(getNexusRule('LA', '2023-07-31')?.test).toBe('or');
    expect(getNexusRule('LA', '2023-08-01')?.test).toBe('none');
    expect(getNexusRule('IN', '2023-12-31')?.test).toBe('or');
    expect(getNexusRule('IN', '2024-01-01')?.test).toBe('none');
    expect(getNexusRule('NC', '2024-06-30')?.test).toBe('or');
    expect(getNexusRule('NC', '2024-07-01')?.test).toBe('none');
    expect(getNexusRule('WY', '2024-06-30')?.test).toBe('or');
    expect(getNexusRule('WY', '2024-07-01')?.test).toBe('none');
    expect(getNexusRule('AK', '2024-12-31')?.test).toBe('or');
    expect(getNexusRule('AK', '2025-01-01')?.test).toBe('none');
    expect(getNexusRule('ME', '2021-12-31')?.test).toBe('or');
    expect(getNexusRule('ME', '2022-01-01')?.test).toBe('none');
    expect(getNexusRule('WI', '2021-02-19')?.test).toBe('or');
    expect(getNexusRule('WI', '2021-02-20')?.test).toBe('none');
  });

  it('steps Arizona\'s threshold down over three years', () => {
    expect(getNexusRule('AZ', '2019-12-31')?.salesThreshold).toBe(200_000);
    expect(getNexusRule('AZ', '2020-06-01')?.salesThreshold).toBe(150_000);
    expect(getNexusRule('AZ', '2021-01-01')?.salesThreshold).toBe(100_000);
    expect(getNexusRule('AZ', TODAY)?.salesThreshold).toBe(100_000);
  });

  it('moves North Carolina to 60 days from July 2026 and says that is unconfirmed', () => {
    expect(getNexusRule('NC', '2026-06-30')?.collectionStart).toEqual({ kind: 'next_transaction' });
    const rule = getNexusRule('NC', '2026-07-01');
    expect(rule?.collectionStart).toEqual({ kind: 'days_after', days: 60 });
    expect(rule?.unverified).toContain('collection_start');
  });

  it('has no rule before a state\'s first version or for an unknown state', () => {
    expect(getNexusRule('MO', '2022-12-31')).toBeUndefined();
    expect(getNexusRule('MO', '2023-01-01')?.salesThreshold).toBe(100_000);
    expect(getNexusRule('XX', TODAY)).toBeUndefined();
    expect(getNexusRuleHistory('XX')).toEqual([]);
  });

  it('accepts lower case state codes', () => {
    expect(getNexusRule('ca', TODAY)?.stateCode).toBe('CA' satisfies NexusJurisdictionCode);
  });
});
