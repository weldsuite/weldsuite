import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  actorLabel,
  caseMetrics,
  changedFields,
  cleanLimitOverrides,
  computedTrustFromWorkspace,
  describeRiskReason,
  eventValueLabel,
  formatAgainstQuota,
  guardModeLabel,
  humanizeKey,
  isOutboundInspect,
  isPlatformStatus,
  limitDefault,
  limitOverridesToForm,
  outboundHref,
  parseLimitOverridesForm,
  pickPolicySnapshot,
  planPolicyUpdate,
  quotaShare,
  readFilters,
  reviewOptions,
  riskTone,
  sameLimitOverrides,
  trustDisplay,
  verdictLine,
  type LimitOverrideFormValues,
  type PolicySnapshot,
} from './outbound-mail';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

const blankLimits = (): LimitOverrideFormValues => ({
  recipientsPerMessage: '',
  senderPerHour: '',
  senderPerDay: '',
  workspacePerDay: '',
  firstContactPerDay: '',
  repliesPerSenderPerDay: '',
  monthlyRecipients: '',
});

describe('computedTrustFromWorkspace', () => {
  const paid = {
    subscriptionStatus: 'active',
    planPriceMonthly: '49.00',
    compGrantedAt: null,
    billingMode: 'direct',
  };

  it('keeps a workspace without a paid plan new, however old', () => {
    expect(computedTrustFromWorkspace({ ...paid, createdAt: daysAgo(400), planPriceMonthly: '0' }, NOW)).toBe('new');
    expect(computedTrustFromWorkspace({ ...paid, createdAt: daysAgo(400), subscriptionStatus: 'trialing' }, NOW)).toBe('new');
  });

  it('keeps a paying workspace new for its first 14 days', () => {
    expect(computedTrustFromWorkspace({ ...paid, createdAt: daysAgo(13) }, NOW)).toBe('new');
    expect(computedTrustFromWorkspace({ ...paid, createdAt: daysAgo(15) }, NOW)).toBe('standard');
  });

  it('counts comp plans and partner billing as paid', () => {
    const free = { ...paid, subscriptionStatus: null, planPriceMonthly: null, createdAt: daysAgo(30) };
    expect(computedTrustFromWorkspace({ ...free, compGrantedAt: daysAgo(20) }, NOW)).toBe('standard');
    expect(computedTrustFromWorkspace({ ...free, billingMode: 'partner' }, NOW)).toBe('standard');
    expect(computedTrustFromWorkspace(free, NOW)).toBe('new');
  });

  it('never reaches trusted without the ledger record', () => {
    expect(computedTrustFromWorkspace({ ...paid, createdAt: daysAgo(365) }, NOW)).toBe('standard');
  });

  it('treats a price that is not a number as no price', () => {
    expect(computedTrustFromWorkspace({ ...paid, createdAt: daysAgo(30), planPriceMonthly: 'n/a' }, NOW)).toBe('new');
  });
});

describe('trustDisplay', () => {
  it('shows a staff override as pinned', () => {
    expect(trustDisplay('trusted', 'new')).toEqual({ level: 'trusted', pinned: true, label: 'Trusted (set by staff)' });
  });

  it('falls back to the computed level, also for an unknown stored value', () => {
    expect(trustDisplay(null, 'standard')).toEqual({ level: 'standard', pinned: false, label: 'Standard (computed)' });
    expect(trustDisplay('restricted', 'new').label).toBe('New (computed)');
  });
});

describe('riskTone', () => {
  it('follows the thresholds the guard acts on', () => {
    expect(riskTone(0)).toBe('low');
    expect(riskTone(39)).toBe('low');
    expect(riskTone(40)).toBe('review');
    expect(riskTone(70)).toBe('high');
    expect(riskTone(90)).toBe('critical');
    expect(riskTone(null)).toBe('low');
  });
});

describe('describeRiskReason', () => {
  it('puts the machine reasons in words', () => {
    expect(describeRiskReason('first_contact_share:0.80')).toBe("80% of today's recipients are first contact");
    expect(describeRiskReason('template_first_contact:1')).toBe('One template reached 1 first-contact recipient today');
    expect(describeRiskReason('template_first_contact:120')).toBe('One template reached 120 first-contact recipients today');
    expect(describeRiskReason('hard_bounce_rate:0.054')).toBe('Hard bounce rate over 7 days is 5.4%');
    expect(describeRiskReason('complaints:2')).toBe('2 complaints in 7 days');
    expect(describeRiskReason('cold_templates:1')).toBe('1 template classified as cold outreach today');
    expect(describeRiskReason('phishing_verdict')).toContain('phishing');
  });

  it('returns unknown or malformed reasons as they are', () => {
    expect(describeRiskReason('something_new:3')).toBe('something_new:3');
    expect(describeRiskReason('complaints:many')).toBe('complaints:many');
  });
});

describe('limit overrides', () => {
  it('keeps the valid stored keys and drops the rest', () => {
    expect(cleanLimitOverrides({ senderPerDay: 900, recipientsPerMessage: 500, bogus: 1, firstContactPerDay: -1 })).toEqual({
      senderPerDay: 900,
    });
    expect(cleanLimitOverrides({ monthlyRecipients: null })).toEqual({ monthlyRecipients: null });
    expect(cleanLimitOverrides(null)).toEqual({});
    expect(cleanLimitOverrides([1, 2])).toEqual({});
  });

  it('turns stored overrides into form text, blank meaning the default', () => {
    expect(limitOverridesToForm({ senderPerDay: 900, monthlyRecipients: null })).toEqual({
      ...blankLimits(),
      senderPerDay: '900',
    });
  });

  it('parses the form: blanks are no override, thousands separators are fine', () => {
    expect(parseLimitOverridesForm(blankLimits())).toEqual({ ok: true, limits: {} });
    expect(parseLimitOverridesForm({ ...blankLimits(), workspacePerDay: ' 2,000 ', firstContactPerDay: '0' })).toEqual({
      ok: true,
      limits: { workspacePerDay: 2000, firstContactPerDay: 0 },
    });
  });

  it('refuses decimals, negatives and values out of range, naming the field', () => {
    const decimal = parseLimitOverridesForm({ ...blankLimits(), senderPerHour: '1.5' });
    expect(decimal).toEqual({ ok: false, error: 'Per sender per hour must be a whole number, 0 or more.' });
    expect(parseLimitOverridesForm({ ...blankLimits(), senderPerDay: '-3' }).ok).toBe(false);
    const tooMany = parseLimitOverridesForm({ ...blankLimits(), recipientsPerMessage: '51' });
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.error).toMatch(/^Recipients per message: /);
    expect(parseLimitOverridesForm({ ...blankLimits(), recipientsPerMessage: '0' }).ok).toBe(false);
  });

  it('shows the default of the trust level, or of restricted while restricted', () => {
    expect(limitDefault('senderPerDay', 'standard', 'active')).toBe('500');
    expect(limitDefault('workspacePerDay', 'trusted', 'hold')).toBe('10,000');
    expect(limitDefault('senderPerDay', 'trusted', 'restricted')).toBe('50');
    expect(limitDefault('monthlyRecipients', 'new', 'active')).toBe('No cap');
  });

  it('compares overrides by value, not key order', () => {
    expect(sameLimitOverrides({ senderPerDay: 1, workspacePerDay: 2 }, { workspacePerDay: 2, senderPerDay: 1 })).toBe(true);
    expect(sameLimitOverrides({ senderPerDay: 1 }, {})).toBe(false);
    expect(sameLimitOverrides({}, {})).toBe(true);
  });
});

describe('planPolicyUpdate', () => {
  const restricted: PolicySnapshot = {
    ...DEFAULT_POLICY,
    state: 'restricted',
    stateReason: 'Your bounce rate is high.',
  };

  it('changes nothing when the update repeats the current policy', () => {
    const plan = planPolicyUpdate(DEFAULT_POLICY, { state: 'active', limits: {}, trustOverride: null, notes: '' });
    expect(plan).toMatchObject({ ok: true, changed: [], stateChanged: false, events: [] });
  });

  it('needs a customer reason before tightening the state', () => {
    expect(planPolicyUpdate(DEFAULT_POLICY, { state: 'suspended' })).toEqual({
      ok: false,
      error: 'Give the customer a reason for "Suspended". They see it in WeldMail.',
    });
    expect(planPolicyUpdate(DEFAULT_POLICY, { state: 'hold', stateReason: '  ' }).ok).toBe(false);
  });

  it('records a state change with the customer reason', () => {
    const plan = planPolicyUpdate(DEFAULT_POLICY, {
      state: 'suspended',
      stateReason: ' Sending is suspended. Contact support. ',
      allowRepliesWhenSuspended: true,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.stateChanged).toBe(true);
    expect(plan.next.stateReason).toBe('Sending is suspended. Contact support.');
    expect(plan.changed).toEqual(['state', 'stateReason', 'allowRepliesWhenSuspended']);
    expect(plan.events).toEqual([
      {
        kind: 'state_changed',
        fromValue: 'active',
        toValue: 'suspended',
        details: { customerReason: 'Sending is suspended. Contact support.', allowRepliesWhenSuspended: true },
      },
    ]);
  });

  it('clears the customer reason when the workspace goes back to active', () => {
    const plan = planPolicyUpdate(restricted, { state: 'active', stateReason: 'left over' });
    expect(plan).toMatchObject({ ok: true, stateChanged: true, next: { state: 'active', stateReason: null } });
  });

  it('lets staff edit the reason of a restriction the guard set without changing the state', () => {
    const plan = planPolicyUpdate(restricted, { stateReason: 'We are reviewing your sending.' });
    expect(plan).toMatchObject({ ok: true, stateChanged: false, changed: ['stateReason'], events: [] });
  });

  it('records trust and limit changes in the trail', () => {
    const plan = planPolicyUpdate(DEFAULT_POLICY, { trustOverride: 'trusted', limits: { senderPerDay: 900 } });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.events).toEqual([
      { kind: 'trust_changed', fromValue: 'computed', toValue: 'trusted' },
      {
        kind: 'limits_changed',
        fromValue: '0 overrides',
        toValue: '1 override',
        details: { before: {}, after: { senderPerDay: 900 } },
      },
    ]);
  });

  it('keeps what the update leaves out and stores blank notes as none', () => {
    const current: PolicySnapshot = { ...restricted, trustOverride: 'new', limits: { senderPerHour: 5 }, notes: 'Watch this.' };
    const plan = planPolicyUpdate(current, { notes: '   ' });
    expect(plan).toMatchObject({
      ok: true,
      changed: ['notes'],
      next: { trustOverride: 'new', limits: { senderPerHour: 5 }, state: 'restricted', notes: null },
    });
  });

  it('keeps only the editable fields of a stored row', () => {
    const row = { ...DEFAULT_POLICY, notes: 'n', id: 'obpol_1', riskScore: 55, updatedAt: '2026-10-13T00:00:00.000Z' };
    expect(pickPolicySnapshot(row)).toEqual({ ...DEFAULT_POLICY, notes: 'n' });
  });

  it('lists the changed fields in form order', () => {
    expect(changedFields(DEFAULT_POLICY, DEFAULT_POLICY)).toEqual([]);
    expect(
      changedFields(DEFAULT_POLICY, { ...DEFAULT_POLICY, notes: 'x', trustOverride: 'new', limits: { senderPerDay: 1 } }),
    ).toEqual(['trustOverride', 'limits', 'notes']);
  });

  it('puts a pinned level back to computed', () => {
    const plan = planPolicyUpdate({ ...DEFAULT_POLICY, trustOverride: 'trusted' }, { trustOverride: null });
    expect(plan).toMatchObject({ ok: true, events: [{ kind: 'trust_changed', fromValue: 'trusted', toValue: 'computed' }] });
  });
});

describe('cases', () => {
  it('splits the summary from the other metrics and formats the values', () => {
    expect(
      caseMetrics({
        summary: ' Hard bounces above 5%. ',
        hardBounceRate: 0.0712,
        firstContactRecipients: 1200,
        capped: true,
        template: null,
      }),
    ).toEqual({
      summary: 'Hard bounces above 5%.',
      items: [
        { label: 'Hard bounce rate', value: '0.071' },
        { label: 'First contact recipients', value: '1,200' },
        { label: 'Capped', value: 'Yes' },
        { label: 'Template', value: '—' },
      ],
    });
    expect(caseMetrics(null)).toEqual({ summary: null, items: [] });
  });

  it('writes the verdict as one line', () => {
    expect(verdictLine({ category: 'cold_outreach', unsolicited: true, confidence: 0.823, signals: [], modelId: null })).toBe(
      'Cold outreach, 82% sure, unsolicited',
    );
    expect(verdictLine({ category: 'brand_new', unsolicited: false, confidence: 1, signals: [], modelId: null })).toBe(
      'Brand new, 100% sure',
    );
  });

  it('offers the review buttons a case can still take', () => {
    expect(reviewOptions('open')).toEqual(['confirmed', 'dismissed']);
    expect(reviewOptions('confirmed')).toEqual(['dismissed']);
    expect(reviewOptions('dismissed')).toEqual(['confirmed']);
  });
});

describe('labels', () => {
  it('humanizes camelCase and snake_case keys', () => {
    expect(humanizeKey('firstContactRecipients')).toBe('First contact recipients');
    expect(humanizeKey('hard_bounce_rate')).toBe('Hard bounce rate');
    expect(humanizeKey('')).toBe('');
  });

  it('labels the trail values by event kind', () => {
    expect(eventValueLabel('state_changed', 'hold')).toBe('On hold');
    expect(eventValueLabel('trust_changed', 'computed')).toBe('Computed');
    expect(eventValueLabel('case_opened', 'bounce_rate')).toBe('Bounce rate');
    expect(eventValueLabel('case_reviewed', 'dismissed')).toBe('Dismissed');
    expect(eventValueLabel('limits_changed', '2 overrides')).toBe('2 overrides');
    expect(eventValueLabel('state_changed', null)).toBe('—');
  });

  it('names the guard for automatic changes', () => {
    expect(actorLabel('system')).toBe('the guard');
    expect(actorLabel('staff@weldsuite.org')).toBe('staff@weldsuite.org');
    expect(actorLabel(null)).toBeNull();
  });

  it('labels guard modes, unknown ones included', () => {
    expect(guardModeLabel('enforce')).toBe('Enforcing');
    expect(guardModeLabel('canary_mode')).toBe('Canary mode');
  });
});

describe('platform status', () => {
  it('accepts what mail-api sends and nothing else', () => {
    expect(isPlatformStatus({ tripped: false, recipients: 10, quota: 1000, reason: null })).toBe(true);
    expect(isPlatformStatus({ tripped: true, recipients: 10, quota: null, reason: 'Budget reached.' })).toBe(true);
    expect(isPlatformStatus({ tripped: 'no', recipients: 10, quota: null, reason: null })).toBe(false);
    expect(isPlatformStatus({ tripped: false, recipients: 10 })).toBe(false);
    expect(isPlatformStatus(null)).toBe(false);
  });

  it('accepts an inspect answer only when the parts the screen reads are there', () => {
    const inspect = {
      riskScore: 42,
      riskReasons: ['complaints:1'],
      shadowDenials7d: { FIRST_CONTACT_LIMITED: 3 },
      usage: {
        mode: 'shadow',
        trustLevel: 'standard',
        state: 'active',
        stateReason: null,
        limits: { senderPerDay: 500 },
        workspace: { hour: 2, day: { used: 10, limit: 2000 }, firstContactDay: { used: 4, limit: 200 }, month: { used: 90, limit: null } },
        senders: [],
        deliveries7d: { delivered: 1, hardBounces: 0, softBounces: 0, complaints: 0, rejected: 0 },
        coldOutreachCapped: false,
      },
    };
    expect(isOutboundInspect(inspect)).toBe(true);
    expect(isOutboundInspect({ ...inspect, usage: { ...inspect.usage, trustLevel: 'vip' } })).toBe(false);
    expect(isOutboundInspect({ ...inspect, usage: { ...inspect.usage, workspace: { hour: 2 } } })).toBe(false);
    expect(isOutboundInspect({ ...inspect, riskReasons: 'none' })).toBe(false);
    expect(isOutboundInspect(null)).toBe(false);
  });

  it('shows the count against the quota', () => {
    expect(quotaShare(700, 1000)).toBe(0.7);
    expect(quotaShare(700, null)).toBeNull();
    expect(quotaShare(700, 0)).toBeNull();
    expect(formatAgainstQuota(1234, 50_000)).toBe('1,234 of 50,000 (2.5%)');
    expect(formatAgainstQuota(1234, null)).toBe('1,234');
  });
});

describe('screen filters', () => {
  it('reads search params, defaulting cases to open and the rest to all', () => {
    expect(readFilters({})).toEqual({ state: 'all', status: 'open', trigger: 'all', severity: 'all', caseId: null });
    expect(
      readFilters({ state: 'hold', status: 'all', trigger: 'phishing', severity: ['urgent', 'info'], case: ' obcase_1 ' }),
    ).toEqual({ state: 'hold', status: 'all', trigger: 'phishing', severity: 'urgent', caseId: 'obcase_1' });
    expect(readFilters({ state: 'bogus', status: 'nope', case: 'x'.repeat(31) })).toMatchObject({
      state: 'all',
      status: 'open',
      caseId: null,
    });
  });

  it('builds links that leave the defaults out', () => {
    const filters = readFilters({});
    expect(outboundHref(filters)).toBe('/outbound-mail');
    expect(outboundHref(filters, { state: 'restricted', status: 'dismissed' })).toBe(
      '/outbound-mail?state=restricted&status=dismissed',
    );
    expect(outboundHref({ ...filters, caseId: 'obcase_1' }, { trigger: 'complaints' })).toBe(
      '/outbound-mail?trigger=complaints&case=obcase_1',
    );
  });
});
