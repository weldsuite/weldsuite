/**
 * The SLA engine's pure parts: business-time arithmetic, policy selection and
 * the timeline replay that every clock is derived from.
 */

import { describe, expect, it } from 'vitest';
import type { HelpdeskSla } from '../schema/helpdesk-slas';
import { addBusinessMs, businessMsBetween, toDeskSlaCalendar } from './desk-sla-calendar';
import {
  deriveDeskSlaClocks,
  deskSlaNextCheckAt,
  deskSlaTargets,
  selectDeskSlaPolicy,
  summarizeDeskSla,
  type DeskSlaTimelineEntry,
} from './desk-sla';

const weekdays = { isOpen: true, openTime: '09:00', closeTime: '17:00' };
/** Mon–Fri 09:00–17:00 Amsterdam. */
const office = toDeskSlaCalendar({
  timezone: 'Europe/Amsterdam',
  monday: weekdays,
  tuesday: weekdays,
  wednesday: weekdays,
  thursday: weekdays,
  friday: weekdays,
  holidays: [{ date: '2026-12-25', name: 'Christmas', isRecurring: true }],
});

const at = (iso: string) => new Date(iso);
const HOUR = 3_600_000;

describe('business-time calendar', () => {
  it('counts wall-clock time for 24x7', () => {
    expect(businessMsBetween(null, at('2026-11-02T10:00:00Z'), at('2026-11-02T11:30:00Z'))).toBe(HOUR * 1.5);
    expect(addBusinessMs(null, at('2026-11-02T10:00:00Z'), HOUR)).toEqual(at('2026-11-02T11:00:00Z'));
  });

  it('only counts open hours, in the calendar timezone', () => {
    // Monday 2 Nov 2026, 16:00 Amsterdam (CET, UTC+1) → Tuesday 10:00: 1h Monday + 1h Tuesday.
    expect(businessMsBetween(office, at('2026-11-02T15:00:00Z'), at('2026-11-03T09:00:00Z'))).toBe(2 * HOUR);
  });

  it('carries a target over the night and the weekend', () => {
    // Friday 6 Nov 16:00 CET + 2 business hours = Monday 9 Nov 10:00 CET.
    expect(addBusinessMs(office, at('2026-11-06T15:00:00Z'), 2 * HOUR)).toEqual(at('2026-11-09T09:00:00Z'));
  });

  it('starts counting at opening time when the clock starts outside hours', () => {
    // Saturday → first business hour ends Monday 10:00 CET.
    expect(addBusinessMs(office, at('2026-11-07T12:00:00Z'), HOUR)).toEqual(at('2026-11-09T09:00:00Z'));
  });

  it('skips recurring holidays', () => {
    // Thursday 24 Dec 2026 16:00 CET + 2h: Christmas (Fri) is closed → Monday 28 Dec 10:00.
    expect(addBusinessMs(office, at('2026-12-24T15:00:00Z'), 2 * HOUR)).toEqual(at('2026-12-28T09:00:00Z'));
  });

  it('follows daylight saving time', () => {
    // Monday 30 Mar 2026 is CEST (UTC+2): 09:00 local opens at 07:00Z.
    expect(addBusinessMs(office, at('2026-03-30T06:00:00Z'), HOUR)).toEqual(at('2026-03-30T08:00:00Z'));
  });

  it('treats a calendar that never opens as 24x7', () => {
    expect(toDeskSlaCalendar({ timezone: 'UTC', monday: { isOpen: false } })).toBeNull();
  });
});

function policy(overrides: Partial<HelpdeskSla>): HelpdeskSla {
  return {
    id: 'sla_1',
    createdAt: at('2026-01-01T00:00:00Z'),
    updatedAt: at('2026-01-01T00:00:00Z'),
    deletedAt: null,
    name: 'Standard',
    description: null,
    conditions: [],
    isDefault: false,
    firstResponseTime: [{ priority: 'medium', time: 60 }],
    resolutionTime: [{ priority: 'medium', time: 480 }],
    updateTime: [{ priority: 'medium', time: 120 }],
    operationalHours: '24x7',
    businessHours: null,
    escalationRules: null,
    isActive: true,
    priority: 0,
    reminders: null,
    ...overrides,
  };
}

const conversation = {
  priority: null,
  channel: 'email' as const,
  ticketTypeId: null,
  departmentId: null,
  tags: ['vip'],
  assigneeId: null,
  email: 'jane@example.com',
};

describe('policy selection', () => {
  it('picks the first matching conditional policy, else the default', () => {
    const fallback = policy({ id: 'sla_default', isDefault: true, conditions: [] });
    const vip = policy({ id: 'sla_vip', priority: 1, conditions: [{ field: 'tags', operator: 'contains', value: 'VIP' }] });
    const phone = policy({ id: 'sla_phone', priority: 0, conditions: [{ field: 'channel', operator: 'equals', value: 'phone' }] });
    expect(selectDeskSlaPolicy([fallback, vip, phone], conversation)?.id).toBe('sla_vip');
    expect(selectDeskSlaPolicy([fallback, phone], conversation)?.id).toBe('sla_default');
  });

  it('ignores inactive policies and conditions on unknown fields', () => {
    const inactive = policy({ id: 'sla_off', isActive: false });
    const legacy = policy({ id: 'sla_legacy', conditions: [{ field: 'category', operator: 'equals', value: 'billing' }] });
    expect(selectDeskSlaPolicy([inactive, legacy], conversation)).toBeNull();
  });

  it('compares priorities by rank', () => {
    const urgent = policy({ conditions: [{ field: 'priority', operator: 'greater_than', value: 'medium' }] });
    expect(selectDeskSlaPolicy([urgent], { ...conversation, priority: 'urgent' })).not.toBeNull();
    expect(selectDeskSlaPolicy([urgent], { ...conversation, priority: 'low' })).toBeNull();
  });

  it('measures a conversation without a priority on the medium targets, warning at 75% by default', () => {
    expect(deskSlaTargets(policy({}), null)).toEqual({
      first_response: { targetMinutes: 60, warnBeforeMinutes: 15 },
      next_response: { targetMinutes: 120, warnBeforeMinutes: 30 },
      resolution: { targetMinutes: 480, warnBeforeMinutes: 120 },
    });
    expect(deskSlaTargets(policy({}), 'high')).toEqual({});
  });

  it('warns at the reminder the policy sets', () => {
    const p = policy({ reminders: [{ type: 'before_breach', time: 10, recipients: ['assignee'] }] });
    expect(deskSlaTargets(p, 'medium').first_response?.warnBeforeMinutes).toBe(10);
  });
});

const targets = deskSlaTargets(policy({}), 'medium');
const t0 = at('2026-11-02T10:00:00Z');
const plus = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
const visitor = (m: number): DeskSlaTimelineEntry => ({ at: plus(m), kind: 'message', authorType: 'visitor' });
const agent = (m: number): DeskSlaTimelineEntry => ({ at: plus(m), kind: 'message', authorType: 'agent' });
const bot = (m: number): DeskSlaTimelineEntry => ({ at: plus(m), kind: 'message', authorType: 'bot' });
const event = (m: number, eventType: string): DeskSlaTimelineEntry => ({
  at: plus(m),
  kind: 'event',
  authorType: 'agent',
  eventType,
});

function clocksAt(timeline: DeskSlaTimelineEntry[], minutes: number) {
  const derived = deriveDeskSlaClocks({ timeline, targets, calendar: null, now: plus(minutes) });
  return Object.fromEntries(derived.map((c) => [c.metric, c]));
}

describe('timeline replay', () => {
  it('starts first response and resolution on the first visitor message', () => {
    const { first_response, resolution, next_response } = clocksAt([visitor(0)], 10);
    expect(first_response).toMatchObject({ status: 'running', elapsedSeconds: 600, dueAt: plus(60), warnAt: plus(45) });
    expect(resolution).toMatchObject({ status: 'running', dueAt: plus(480) });
    expect(next_response).toBeUndefined();
  });

  it('meets first response on the first agent reply and pauses resolution while waiting on the customer', () => {
    const { first_response, resolution } = clocksAt([visitor(0), agent(30)], 300);
    expect(first_response).toMatchObject({ status: 'completed', elapsedSeconds: 1800, breachedAt: null, completedAt: plus(30) });
    expect(resolution).toMatchObject({ status: 'paused', elapsedSeconds: 1800, dueAt: null });
  });

  it('does not let a bot reply meet or pause a clock', () => {
    const { first_response, resolution } = clocksAt([visitor(0), bot(1)], 10);
    expect(first_response?.status).toBe('running');
    expect(resolution?.status).toBe('running');
  });

  it('runs a next-response cycle when the customer writes again, and resumes resolution', () => {
    const { next_response, resolution } = clocksAt([visitor(0), agent(30), visitor(200)], 260);
    expect(next_response).toMatchObject({ status: 'running', startedAt: plus(200), elapsedSeconds: 3600, dueAt: plus(320) });
    // 30 min before the reply + 60 min since the customer wrote again.
    expect(resolution).toMatchObject({ status: 'running', elapsedSeconds: 5400, dueAt: plus(260 + 390) });
  });

  it('records the breach time of a late reply', () => {
    const { first_response } = clocksAt([visitor(0), agent(90)], 100);
    expect(first_response).toMatchObject({ status: 'completed', breachedAt: plus(60) });
  });

  it('reports a running clock past its target as breached at its due time', () => {
    const { first_response } = clocksAt([visitor(0)], 70);
    expect(first_response).toMatchObject({ status: 'running', breachedAt: plus(60), dueAt: plus(60) });
  });

  it('cancels reply clocks and completes resolution on close; a visitor message reopens it', () => {
    const closed = clocksAt([visitor(0), event(20, 'closed')], 30);
    expect(closed.first_response).toMatchObject({ status: 'cancelled', breachedAt: null });
    expect(closed.resolution).toMatchObject({ status: 'completed', completedAt: plus(20) });

    const reopened = clocksAt([visitor(0), event(20, 'closed'), visitor(100)], 110);
    expect(reopened.resolution).toMatchObject({ status: 'running', elapsedSeconds: 1800, completedAt: null });
    expect(reopened.next_response).toMatchObject({ status: 'running', startedAt: plus(100) });
  });

  it('keeps resolution paused when the team reopens, until the customer writes', () => {
    const { resolution } = clocksAt([visitor(0), agent(10), event(20, 'closed'), event(30, 'reopened')], 60);
    expect(resolution).toMatchObject({ status: 'paused', elapsedSeconds: 600 });
  });

  it('gives a conversation the team started no first-response clock', () => {
    const { first_response, resolution, next_response } = clocksAt([agent(0), visitor(10)], 20);
    expect(first_response).toBeUndefined();
    expect(next_response).toMatchObject({ status: 'running', startedAt: plus(10) });
    expect(resolution).toMatchObject({ status: 'running', elapsedSeconds: 600 });
  });
});

describe('summary and scheduling', () => {
  it('shows the running clock that comes due first', () => {
    const rows = deriveDeskSlaClocks({ timeline: [visitor(0)], targets, calendar: null, now: plus(50) }).map((c) => ({
      ...c,
      warnedAt: null,
      breachNotifiedAt: null,
    }));
    expect(summarizeDeskSla(rows, plus(50))).toEqual({ slaStatus: 'warning', slaDueAt: plus(60), slaMetric: 'first_response' });
  });

  it('checks again at the warning, then the due time, then not after the breach was announced', () => {
    const clock = {
      metric: 'first_response' as const,
      status: 'running' as const,
      dueAt: plus(60),
      warnAt: plus(45),
      breachedAt: null,
      warnedAt: null,
      breachNotifiedAt: null,
    };
    expect(deskSlaNextCheckAt(clock)).toEqual(plus(45));
    expect(deskSlaNextCheckAt({ ...clock, warnedAt: plus(45) })).toEqual(plus(60));
    expect(deskSlaNextCheckAt({ ...clock, breachedAt: plus(60) })).toEqual(plus(60));
    expect(deskSlaNextCheckAt({ ...clock, breachedAt: plus(60), breachNotifiedAt: plus(61) })).toBeNull();
    expect(deskSlaNextCheckAt({ ...clock, status: 'paused' })).toBeNull();
  });
});
