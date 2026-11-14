import { describe, expect, it } from 'vitest';
import type { PanelActivityEvent } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import type { PanelSessionRow } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { buildSessionTimeline } from './session-timeline';

const session: PanelSessionRow = {
  sessionId: 'ses_1',
  startedAt: '2026-11-10T10:00:00.000Z',
  endedAt: '2026-11-10T10:05:00.000Z',
  durationSeconds: 300,
  pageviews: 2,
  clicks: 3,
  events: 9,
  rageClicks: 1,
  deadClicks: 0,
  quickBacks: 0,
  excessiveScrolls: 0,
  errors: 1,
  entryPage: '/pricing',
  exitPage: '/checkout',
  deviceType: 'mobile',
  browser: 'Safari',
  os: 'iOS',
  country: 'NL',
  distinctId: 'ada@example.com',
  userId: 'ada@example.com',
  hasRecording: true,
  chunkCount: 2,
  favorite: false,
};

let n = 0;
function event(name: string, ts: string, extra: Partial<PanelActivityEvent> = {}): PanelActivityEvent {
  n += 1;
  return { eventId: `e${n}`, name, ts, path: null, url: null, title: null, sessionId: 'ses_1', detail: null, properties: {}, ...extra };
}

describe('buildSessionTimeline', () => {
  it('lists pages with the time on each, clicks, frustration, errors and custom events in order', () => {
    const text = buildSessionTimeline(session, [
      // Out of order on purpose: the timeline sorts.
      event('$exception', '2026-11-10T10:04:00.000Z', { detail: 'pay is not defined' }),
      event('$pageview', '2026-11-10T10:00:00.000Z', { path: '/pricing', title: 'Pricing' }),
      event('$autocapture', '2026-11-10T10:00:30.000Z', { detail: 'Choose Pro', properties: { $action: 'click' } }),
      event('$pageview', '2026-11-10T10:01:00.000Z', { path: '/checkout' }),
      event('Started checkout', '2026-11-10T10:01:10.000Z', { properties: { plan: 'pro' } }),
      event('$autocapture', '2026-11-10T10:02:00.000Z', { detail: 'Place order', properties: { $action: 'submit' } }),
      event('$rageclick', '2026-11-10T10:03:00.000Z', { detail: 'Pay now' }),
    ]);

    expect(text).toContain('Duration 5m 0s · 2 pages · 3 clicks · signals: 1 rage click, 1 error · device: mobile / Safari / iOS · country: NL');
    expect(text).toContain('Entry page: /pricing');
    expect(text).toContain("The visitor's last page was /checkout.");
    const lines = text.split('Timeline:\n')[1]?.split('\n') ?? [];
    expect(lines).toEqual([
      '[0:00] Opened /pricing "Pricing" (1m 0s on the page)',
      '[0:30] Clicked "Choose Pro"',
      '[1:00] Opened /checkout (4m 0s on the page)',
      '[1:10] Event "Started checkout"',
      '[2:00] Submitted a form via "Place order"',
      '[3:00] Frustration: rage click (three or more fast clicks) on "Pay now"',
      '[4:00] Error on the page: pay is not defined',
    ]);
  });

  it('never names the person and never includes event properties', () => {
    const text = buildSessionTimeline(session, [
      event('Started checkout', '2026-11-10T10:01:10.000Z', { properties: { email: 'ada@example.com', card: '4111' } }),
    ]);
    expect(text).not.toContain('ada@example.com');
    expect(text).not.toContain('4111');
    expect(text).not.toContain('email');
  });

  it('says so for a clicked element with no text, and cuts long text', () => {
    const text = buildSessionTimeline(session, [
      event('$autocapture', '2026-11-10T10:01:00.000Z', { detail: null, properties: { $action: 'click' } }),
      event('$autocapture', '2026-11-10T10:02:00.000Z', { detail: `  ${'x'.repeat(300)}  `, properties: { $action: 'click' } }),
    ]);
    expect(text).toContain('Clicked (no visible text)');
    expect(text).toContain(`"${'x'.repeat(79)}…"`);
    expect(text).not.toContain('x'.repeat(100));
  });

  it('keeps the start and the end of a very long session', () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      event('Step', new Date(Date.parse('2026-11-10T10:00:00.000Z') + i * 500).toISOString()),
    );
    const text = buildSessionTimeline(session, many);
    const lines = text.split('Timeline:\n')[1]?.split('\n') ?? [];
    expect(lines.length).toBeLessThanOrEqual(151);
    expect(lines[0]).toContain('[0:00] Event "Step"');
    expect(lines.some((l) => l.includes('events left out'))).toBe(true);
    expect(lines.at(-1)).toContain('Event "Step"');
    expect(text.length).toBeLessThan(9000);
  });

  it('handles a session with no events', () => {
    expect(buildSessionTimeline(session, [])).toContain('(no events)');
  });
});
