import { describe, expect, it } from 'vitest';
import { WELDREACH_DEFAULT_LIMITS, WELDREACH_TERMS } from '@weldsuite/app-api-client/schemas/reach';
import {
  ACCESS_STATUSES,
  TERM_LABELS,
  availableActions,
  countryLabel,
  formatAgainstLimit,
  formatRate,
  isConsentCountry,
  limitsToFormValues,
  parseDomainList,
  parseLimitsForm,
  planAccessUpdate,
  rate,
  type AccessAction,
  type LimitsFormValues,
} from './app-access';

const NOW = new Date('2026-10-12T10:00:00.000Z');

const plan = (action: AccessAction, from: Parameters<typeof planAccessUpdate>[0]['from'], extra = {}) =>
  planAccessUpdate({
    action,
    from,
    appCode: 'weldreach',
    reason: 'Reviewed the answers',
    reviewer: 'ops@weldsuite.org',
    currentLimits: { ...WELDREACH_DEFAULT_LIMITS },
    now: NOW,
    ...extra,
  });

describe('availableActions', () => {
  it.each([
    ['none', ['approve']],
    ['requested', ['approve', 'reject']],
    ['approved', ['suspend', 'revoke']],
    ['suspended', ['unsuspend', 'revoke']],
    ['rejected', ['approve']],
    ['revoked', ['approve']],
  ] as const)('from %s offers %j', (status, expected) => {
    expect(availableActions(status)).toEqual(expected);
  });

  it('offers something from every status', () => {
    for (const status of ACCESS_STATUSES) expect(availableActions(status).length).toBeGreaterThan(0);
  });
});

describe('planAccessUpdate', () => {
  it('approves a request: approved, reviewer and time recorded, reasons cleared', () => {
    const result = plan('approve', 'requested');
    expect(result).toEqual({
      ok: true,
      set: {
        status: 'approved',
        reviewedBy: 'ops@weldsuite.org',
        reviewedAt: NOW,
        rejectionReason: null,
        suspendedReason: null,
      },
    });
  });

  it('fills the default limits when approving a row that has none', () => {
    const result = plan('approve', 'requested', { currentLimits: {} });
    expect(result.ok && result.set.limits).toEqual(WELDREACH_DEFAULT_LIMITS);
  });

  it('keeps limits staff already set', () => {
    const result = plan('approve', 'requested', { currentLimits: { maxMailboxes: 50 } });
    expect(result.ok && result.set.limits).toBeUndefined();
  });

  it('does not invent limits for another app', () => {
    const result = plan('approve', 'none', { appCode: 'weldfoo', currentLimits: {} });
    expect(result.ok && result.set.limits).toBeUndefined();
  });

  it('rejects with the reason shown to the workspace', () => {
    const result = plan('reject', 'requested', { reason: '  Explain where the lists come from  ' });
    expect(result).toMatchObject({
      ok: true,
      set: { status: 'rejected', rejectionReason: 'Explain where the lists come from', suspendedReason: null },
    });
  });

  it('suspends with the reason shown to the workspace', () => {
    const result = plan('suspend', 'approved', { reason: 'Complaint rate too high' });
    expect(result).toMatchObject({
      ok: true,
      set: { status: 'suspended', suspendedReason: 'Complaint rate too high', rejectionReason: null },
    });
  });

  it('unsuspends back to approved and clears the suspension reason', () => {
    expect(plan('unsuspend', 'suspended')).toMatchObject({
      ok: true,
      set: { status: 'approved', suspendedReason: null },
    });
  });

  it('revokes from approved and from suspended, keeping the reason out of the row', () => {
    for (const from of ['approved', 'suspended'] as const) {
      expect(plan('revoke', from)).toMatchObject({
        ok: true,
        set: { status: 'revoked', rejectionReason: null, suspendedReason: null },
      });
    }
  });

  it('lets staff approve after a rejection', () => {
    expect(plan('approve', 'rejected')).toMatchObject({ ok: true, set: { status: 'approved', rejectionReason: null } });
  });

  it.each([
    ['approve', 'approved'],
    ['approve', 'suspended'],
    ['reject', 'approved'],
    ['reject', 'none'],
    ['suspend', 'requested'],
    ['suspend', 'suspended'],
    ['unsuspend', 'approved'],
    ['revoke', 'requested'],
    ['revoke', 'rejected'],
  ] as const)('refuses to %s from %s', (action, from) => {
    const result = plan(action, from);
    expect(result.ok).toBe(false);
  });

  it('says so in plain words when nothing was requested', () => {
    expect(plan('reject', 'none')).toEqual({ ok: false, error: 'Cannot reject access that is not requested.' });
  });

  it('needs a reason of at least three characters', () => {
    expect(plan('reject', 'requested', { reason: '  ok ' }).ok).toBe(false);
    expect(plan('reject', 'requested', { reason: '' }).ok).toBe(false);
    expect(plan('reject', 'requested', { reason: 'ok!' }).ok).toBe(true);
  });
});

describe('limits form', () => {
  const values = (overrides: Partial<LimitsFormValues> = {}): LimitsFormValues => ({
    maxDomains: '3',
    maxMailboxes: '10',
    maxDailySends: '300',
    allowConsumerRecipients: false,
    forceAllowDomains: '',
    ...overrides,
  });

  it('prefills the defaults when nothing is stored', () => {
    expect(limitsToFormValues({})).toEqual(values());
    expect(limitsToFormValues(null)).toEqual(values());
  });

  it('prefills what is stored, one domain per line', () => {
    expect(
      limitsToFormValues({ maxMailboxes: 25, allowConsumerRecipients: true, forceAllowDomains: ['a.nl', 'b.nl'] }),
    ).toEqual(values({ maxMailboxes: '25', allowConsumerRecipients: true, forceAllowDomains: 'a.nl\nb.nl' }));
  });

  it('falls back to the default for a stored value of the wrong type', () => {
    expect(limitsToFormValues({ maxDomains: 'many' }).maxDomains).toBe('3');
  });

  it('parses the defaults back to the defaults', () => {
    expect(parseLimitsForm(values())).toEqual({ ok: true, limits: WELDREACH_DEFAULT_LIMITS });
  });

  it('parses numbers, the consumer switch and the domain list', () => {
    const result = parseLimitsForm(
      values({
        maxDomains: ' 5 ',
        maxMailboxes: '40',
        maxDailySends: '1500',
        allowConsumerRecipients: true,
        forceAllowDomains: 'Acme.com\nshop.acme.com, ACME.com ',
      }),
    );
    expect(result).toEqual({
      ok: true,
      limits: {
        maxDomains: 5,
        maxMailboxes: 40,
        maxDailySends: 1500,
        allowConsumerRecipients: true,
        forceAllowDomains: ['acme.com', 'shop.acme.com'],
      },
    });
  });

  it('allows a zero limit (switches the thing off)', () => {
    const result = parseLimitsForm(values({ maxDomains: '0' }));
    expect(result.ok && result.limits.maxDomains).toBe(0);
  });

  it.each([
    ['maxDomains', '-1'],
    ['maxDomains', '2.5'],
    ['maxMailboxes', 'ten'],
    ['maxDailySends', ''],
    ['maxDomains', '1001'],
    ['maxMailboxes', '10001'],
    ['maxDailySends', '1000001'],
  ] as const)('refuses %s = "%s"', (field, value) => {
    const result = parseLimitsForm(values({ [field]: value }));
    expect(result.ok).toBe(false);
  });

  it('names the entries that are not domains', () => {
    const result = parseLimitsForm(values({ forceAllowDomains: 'acme.com\nnot a domain\nhttp://x' }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('not');
  });
});

describe('parseDomainList', () => {
  it('splits on lines, commas, semicolons and spaces, lowercases and de-duplicates', () => {
    expect(parseDomainList('A.com, b.nl;\nc.co.uk  a.com')).toEqual({
      domains: ['a.com', 'b.nl', 'c.co.uk'],
      invalid: [],
    });
  });

  it('drops a trailing dot', () => {
    expect(parseDomainList('acme.com.').domains).toEqual(['acme.com']);
  });

  it('reports what is not a domain', () => {
    expect(parseDomainList('acme.com localhost -bad.com a_b.com https://x.com').invalid).toEqual([
      'localhost',
      '-bad.com',
      'a_b.com',
      'https://x.com',
    ]);
  });

  it('is empty for blank input', () => {
    expect(parseDomainList(' \n , ')).toEqual({ domains: [], invalid: [] });
  });
});

describe('request answers', () => {
  it('labels every term in the contract', () => {
    for (const key of WELDREACH_TERMS) expect(TERM_LABELS[key]).toBeTruthy();
  });

  it('flags the countries that need prior consent', () => {
    expect(isConsentCountry('nl')).toBe(true);
    expect(isConsentCountry('DE')).toBe(true);
    expect(isConsentCountry('BE')).toBe(false);
  });

  it('names a country, or shows the code', () => {
    expect(countryLabel('nl')).toBe('Netherlands (NL)');
    expect(countryLabel('zz')).toMatch(/ZZ/);
  });
});

describe('usage figures', () => {
  it('divides, and has no rate without sends', () => {
    expect(rate(5, 100)).toBe(0.05);
    expect(rate(5, 0)).toBeNull();
    expect(rate(null, 100)).toBeNull();
    expect(rate(5, null)).toBeNull();
  });

  it('formats rates with a decimal below 10 %', () => {
    expect(formatRate(0.032)).toBe('3.2%');
    expect(formatRate(0.25)).toBe('25%');
    expect(formatRate(null)).toBe('—');
  });

  it('formats a count against its limit', () => {
    expect(formatAgainstLimit(2, 3)).toBe('2 / 3');
    expect(formatAgainstLimit(2, null)).toBe('2');
    expect(formatAgainstLimit(null, 3)).toBe('—');
  });
});
