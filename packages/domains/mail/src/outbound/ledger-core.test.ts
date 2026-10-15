import { beforeEach, describe, expect, it } from 'vitest';
import { OUTBOUND_DEFAULT_LIMITS, OUTBOUND_THRESHOLDS } from '@weldsuite/app-api-client/schemas/outbound-mail';
import { LedgerCore, type LedgerPolicy, type LedgerStore, type ReserveRequest, type StoredVerdict } from './ledger-core';

/** In-memory stand-in for a Durable Object's storage. */
function memoryStore(): LedgerStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(key: string) {
      return data.get(key) as T | undefined;
    },
    async put(entries: Record<string, unknown>) {
      for (const [k, v] of Object.entries(entries)) data.set(k, structuredClone(v));
    },
    async delete(keys: string[]) {
      for (const k of keys) data.delete(k);
      return keys.length;
    },
    async list<T>({ prefix }: { prefix: string }) {
      const out = new Map<string, T>();
      for (const [k, v] of data) if (k.startsWith(prefix)) out.set(k, structuredClone(v) as T);
      return out;
    },
  };
}

const START = Date.UTC(2026, 9, 13, 9, 30);
let now = START;
const clock = () => now;

function policy(overrides: Partial<LedgerPolicy> = {}): LedgerPolicy {
  return {
    mode: 'enforce',
    trustLevel: 'standard',
    state: 'active',
    stateReason: null,
    stateSetBy: null,
    stateSetAt: null,
    allowRepliesWhenSuspended: false,
    limits: { ...OUTBOUND_DEFAULT_LIMITS.standard },
    ...overrides,
  };
}

function request(overrides: Partial<ReserveRequest> = {}): ReserveRequest {
  return {
    sender: 'tom@acme.com',
    source: 'compose',
    kind: 'new_thread',
    recipients: ['a@x.com'],
    firstContact: [],
    template: null,
    contentScore: 0,
    sharedDomain: false,
    ...overrides,
  };
}

function send(core: LedgerCore, p: LedgerPolicy, req: ReserveRequest, platformTripped = false) {
  const decision = core.reserve({ policy: p, platformTripped }, req);
  if (decision.allow && decision.reservationId) core.commit(p, decision.reservationId);
  return decision;
}

const recipients = (n: number, domain = 'x.com') => Array.from({ length: n }, (_, i) => `r${i}@${domain}`);

describe('LedgerCore', () => {
  let store: ReturnType<typeof memoryStore>;
  let core: LedgerCore;

  beforeEach(async () => {
    now = START;
    store = memoryStore();
    core = new LedgerCore(store, clock);
    await core.load();
  });

  it('allows sends within the limits and counts recipients', () => {
    const decision = send(core, policy(), request({ recipients: recipients(3) }));
    expect(decision.allow).toBe(true);
    expect(core.usage(policy()).workspace.day.used).toBe(3);
  });

  it('refuses more recipients than one message may have', () => {
    const decision = core.reserve({ policy: policy({ trustLevel: 'new', limits: { ...OUTBOUND_DEFAULT_LIMITS.new } }), platformTripped: false }, request({ recipients: recipients(21) }));
    expect(decision.allow).toBe(false);
    expect(decision.denial).toMatchObject({ code: 'TOO_MANY_RECIPIENTS', limit: 20 });
  });

  it('enforces the per-sender hourly window and says when it clears', () => {
    const p = policy();
    for (let i = 0; i < 2; i++) expect(send(core, p, request({ recipients: recipients(50, `d${i}.com`) })).allow).toBe(true);
    const denied = core.reserve({ policy: p, platformTripped: false }, request({ recipients: ['one@more.com'] }));
    expect(denied.denial).toMatchObject({ code: 'SENDING_LIMITED', window: 'hour', limit: 100 });
    expect(denied.denial?.retryAfter).toBe(new Date(Date.UTC(2026, 9, 13, 10)).toISOString());
    now += 60 * 60_000;
    expect(send(core, p, request({ recipients: ['one@more.com'] })).allow).toBe(true);
  });

  it('counts pending reservations against the windows', () => {
    const p = policy({ limits: { ...OUTBOUND_DEFAULT_LIMITS.standard, senderPerHour: 5 } });
    const first = core.reserve({ policy: p, platformTripped: false }, request({ recipients: recipients(5) }));
    expect(first.allow).toBe(true);
    const second = core.reserve({ policy: p, platformTripped: false }, request({ recipients: ['x@y.com'] }));
    expect(second.denial?.code).toBe('SENDING_LIMITED');
    core.release(first.reservationId!);
    expect(core.reserve({ policy: p, platformTripped: false }, request({ recipients: ['x@y.com'] })).allow).toBe(true);
  });

  it("lets a mailbox's own daily cap lower the limit, never raise it", () => {
    const p = policy();
    expect(send(core, p, request({ recipients: recipients(10), senderDailyCap: 10 })).allow).toBe(true);
    expect(core.reserve({ policy: p, platformTripped: false }, request({ recipients: ['x@y.com'], senderDailyCap: 10 })).denial)
      .toMatchObject({ code: 'SENDING_LIMITED', window: 'day', limit: 10 });
    const raised = core.reserve({ policy: p, platformTripped: false }, request({ sender: 'other@acme.com', recipients: ['x@y.com'], senderDailyCap: 99_999 }));
    expect(raised.allow).toBe(true);
  });

  it('caps first contacts per workspace and suggests WeldReach', () => {
    const p = policy({ limits: { ...OUTBOUND_DEFAULT_LIMITS.standard, firstContactPerDay: 3 } });
    expect(send(core, p, request({ recipients: recipients(3), firstContact: recipients(3) })).allow).toBe(true);
    const denied = core.reserve({ policy: p, platformTripped: false }, request({ recipients: ['new@z.com'], firstContact: ['new@z.com'] }));
    expect(denied.denial).toMatchObject({ code: 'FIRST_CONTACT_LIMITED', suggestWeldReach: true, reason: 'workspace_first_contact' });
    // Known people still get mail.
    expect(core.reserve({ policy: p, platformTripped: false }, request({ recipients: ['known@z.com'] })).allow).toBe(true);
  });

  it('applies the shared weldmail.com first-contact cap', () => {
    const p = policy();
    const shared = { sender: 'sales@acme.weldmail.com', sharedDomain: true };
    expect(send(core, p, request({ ...shared, recipients: recipients(20), firstContact: recipients(20) })).allow).toBe(true);
    expect(core.reserve({ policy: p, platformTripped: false }, request({ ...shared, recipients: ['n@z.com'], firstContact: ['n@z.com'] })).denial)
      .toMatchObject({ code: 'FIRST_CONTACT_LIMITED', reason: 'weldmail_shared_domain' });
  });

  it('keeps replies going under the reply floor, also when on hold', () => {
    const p = policy({ state: 'hold', limits: { ...OUTBOUND_DEFAULT_LIMITS.standard, senderPerHour: 1 } });
    expect(core.reserve({ policy: p, platformTripped: false }, request()).denial?.code).toBe('SENDING_ON_HOLD');
    for (let i = 0; i < 5; i++) expect(send(core, p, request({ kind: 'reply', recipients: [`c${i}@x.com`] })).allow).toBe(true);
  });

  it('refuses everything when suspended unless replies are allowed', () => {
    const p = policy({ state: 'suspended' });
    expect(core.reserve({ policy: p, platformTripped: false }, request({ kind: 'reply' })).denial?.code).toBe('SENDING_SUSPENDED');
    const allowReplies = policy({ state: 'suspended', allowRepliesWhenSuspended: true });
    expect(core.reserve({ policy: allowReplies, platformTripped: false }, request({ kind: 'reply' })).allow).toBe(true);
  });

  it('gives invitations from WeldSuite itself workspace windows only', () => {
    const p = policy({ trustLevel: 'new', limits: { ...OUTBOUND_DEFAULT_LIMITS.new } });
    // 40 attendees: over the per-message (20) and per-sender-hour (30) limits of a new workspace.
    const invite = request({ sender: '', source: 'calendar', recipients: recipients(40) });
    expect(send(core, p, invite).allow).toBe(true);
    // The workspace day window (300) still applies.
    const big = request({ sender: '', source: 'meet', recipients: recipients(261, 'y.com') });
    expect(core.reserve({ policy: p, platformTripped: false }, big).denial).toMatchObject({ code: 'SENDING_LIMITED', reason: 'workspace_day' });
  });

  it('refuses an unregistered shared address only when enforcing', () => {
    const req = request({ sender: 'ghost@acme.weldmail.com', sharedDomain: true, senderUnregistered: true });
    expect(core.reserve({ policy: policy(), platformTripped: false }, req).denial).toMatchObject({
      code: 'SENDER_NOT_OWNED',
      reason: 'unregistered_shared_address',
    });
    expect(core.reserve({ policy: policy({ mode: 'shadow' }), platformTripped: false }, req).shadowDenial?.code).toBe('SENDER_NOT_OWNED');
  });

  it('only logs in shadow mode', () => {
    const p = policy({ mode: 'shadow', limits: { ...OUTBOUND_DEFAULT_LIMITS.standard, senderPerHour: 1 } });
    send(core, p, request());
    const decision = core.reserve({ policy: p, platformTripped: false }, request({ recipients: ['b@x.com'] }));
    expect(decision.allow).toBe(true);
    expect(decision.shadowDenial?.code).toBe('SENDING_LIMITED');
    expect(core.shadowCounts()).toEqual({ SENDING_LIMITED: 1 });
  });

  it('skips the ledger entirely in off mode', () => {
    const decision = core.reserve({ policy: policy({ mode: 'off' }), platformTripped: false }, request());
    expect(decision).toEqual({ allow: true, mode: 'off', reservationId: null });
  });

  it('stops first contacts when the platform budget is used, except for trusted workspaces', () => {
    const req = request({ firstContact: ['a@x.com'] });
    expect(core.reserve({ policy: policy(), platformTripped: true }, req).denial?.code).toBe('PLATFORM_LIMITED');
    expect(core.reserve({ policy: policy({ trustLevel: 'trusted' }), platformTripped: true }, req).allow).toBe(true);
  });

  describe('templates and AI verdicts', () => {
    const tpl = { fingerprint: 'a1b2c3d4e5f60718', sample: 'hi tokname quick question', subject: 'Quick question' };

    it('queues a review once a template reaches enough first contacts', () => {
      const p = policy();
      let review;
      for (let i = 0; i < OUTBOUND_THRESHOLDS.reviewFirstContactRecipients; i++) {
        const d = core.reserve({ policy: p, platformTripped: false }, request({ recipients: [`p${i}@d${i}.com`], firstContact: [`p${i}@d${i}.com`], template: tpl, source: 'crm_sequence' }));
        review = core.commit(p, d.reservationId!).review ?? review;
      }
      expect(review).toMatchObject({ fingerprint: tpl.fingerprint, reason: 'template_threshold', firstContactRecipients: 10, sources: ['crm_sequence'] });
    });

    it('samples first-contact sends of a new workspace', () => {
      const p = policy({ trustLevel: 'new', limits: { ...OUTBOUND_DEFAULT_LIMITS.new } });
      const d = core.reserve({ policy: p, platformTripped: false }, request({ firstContact: ['a@x.com'], template: tpl }));
      expect(core.commit(p, d.reservationId!).review?.reason).toBe('new_workspace_sample');
    });

    it('caps a cold-outreach template at its daily first-contact limit', () => {
      const p = policy();
      const verdict: StoredVerdict = {
        fingerprint: tpl.fingerprint,
        category: 'cold_outreach',
        unsolicited: true,
        confidence: 0.9,
        signals: ['meeting request to strangers'],
        modelId: 'test',
        reviewedAt: new Date(now).toISOString(),
      };
      const actions = core.recordVerdict(verdict);
      expect(actions[0]).toMatchObject({ kind: 'case', trigger: 'cold_outreach_template', severity: 'warning' });
      const cap = OUTBOUND_THRESHOLDS.coldTemplateFirstContactPerDay;
      for (let i = 0; i < cap; i++) {
        expect(send(core, p, request({ recipients: [`p${i}@x.com`], firstContact: [`p${i}@x.com`], template: tpl })).allow).toBe(true);
      }
      // A near-duplicate (one bit off) is the same template.
      const nearDup = { ...tpl, fingerprint: 'a1b2c3d4e5f60719' };
      const denied = core.reserve({ policy: p, platformTripped: false }, request({ recipients: ['late@x.com'], firstContact: ['late@x.com'], template: nearDup }));
      expect(denied.denial).toMatchObject({ code: 'FIRST_CONTACT_LIMITED', reason: 'cold_outreach_template', suggestWeldReach: true });
      expect(core.usage(p).coldOutreachCapped).toBe(true);
    });

    it('leaves an info case for a harmless verdict staff asked for', () => {
      const harmless: StoredVerdict = {
        fingerprint: tpl.fingerprint,
        category: 'personal_1to1',
        unsolicited: false,
        confidence: 0.8,
        signals: [],
        modelId: 'test',
        reviewedAt: new Date(now).toISOString(),
      };
      expect(core.recordVerdict(harmless)).toEqual([]);
      expect(core.recordVerdict(harmless, { staffRequested: true })).toEqual([
        expect.objectContaining({ kind: 'case', trigger: 'staff_review', severity: 'info' }),
      ]);
    });

    it('puts the workspace on hold for a phishing verdict', () => {
      const actions = core.recordVerdict({
        fingerprint: tpl.fingerprint,
        category: 'phishing_or_scam',
        unsolicited: true,
        confidence: 0.95,
        signals: ['asks for a password'],
        modelId: 'test',
        reviewedAt: new Date(now).toISOString(),
      });
      expect(actions[0]).toMatchObject({ kind: 'state', toState: 'hold', trigger: 'phishing', severity: 'urgent' });
    });
  });

  describe('risk and automatic actions', () => {
    it('restricts on a high hard-bounce rate', () => {
      const p = policy();
      send(core, p, request({ recipients: recipients(40) }));
      for (let i = 0; i < 4; i++) core.recordDelivery('hard_bounce');
      const { actions, risk } = core.evaluate(p);
      expect(risk.hardBounceRate7d).toBeCloseTo(0.1);
      expect(actions).toContainEqual(expect.objectContaining({ kind: 'state', toState: 'restricted', trigger: 'bounce_rate' }));
    });

    it('restricts on spam complaints', () => {
      const p = policy();
      send(core, p, request({ recipients: recipients(30) }));
      core.recordDelivery('complained');
      core.recordDelivery('complained');
      expect(core.evaluate(p).actions).toContainEqual(expect.objectContaining({ toState: 'restricted', trigger: 'complaints' }));
    });

    it('does not undo a recent staff decision, but opens a case', () => {
      const p = policy({ stateSetBy: 'staff@weldsuite.org', stateSetAt: new Date(now - 60_000).toISOString() });
      send(core, p, request({ recipients: recipients(40) }));
      for (let i = 0; i < 4; i++) core.recordDelivery('hard_bounce');
      const { actions } = core.evaluate(p);
      expect(actions).toContainEqual(expect.objectContaining({ kind: 'case', trigger: 'bounce_rate' }));
      expect(actions.some((a) => a.kind === 'state')).toBe(false);
    });

    it('never loosens: a hold is not turned into a restriction', () => {
      const p = policy({ state: 'hold' });
      send(core, p, request({ kind: 'reply', recipients: recipients(40) }));
      for (let i = 0; i < 4; i++) core.recordDelivery('hard_bounce');
      expect(core.evaluate(p).actions.some((a) => a.kind === 'state')).toBe(false);
    });
  });

  it('persists and reloads its state', async () => {
    send(core, policy(), request({ recipients: recipients(7) }));
    core.recordDelivery('delivered');
    await core.flush();
    const reloaded = new LedgerCore(store, clock);
    await reloaded.load();
    expect(reloaded.usage(policy()).workspace.day.used).toBe(7);
    expect(reloaded.usage(policy()).deliveries7d.delivered).toBe(1);
  });

  it('drops a day window as the hours roll over and prunes old buckets', () => {
    const p = policy({ limits: { ...OUTBOUND_DEFAULT_LIMITS.standard, senderPerDay: 10 } });
    send(core, p, request({ recipients: recipients(10) }));
    expect(core.reserve({ policy: p, platformTripped: false }, request({ recipients: ['x@y.com'] })).denial?.window).toBe('day');
    now += 24 * 60 * 60_000;
    expect(core.reserve({ policy: p, platformTripped: false }, request({ recipients: ['x@y.com'] })).allow).toBe(true);
    now += 9 * 24 * 60 * 60_000;
    expect(core.prune().length).toBeGreaterThan(0);
  });
});
