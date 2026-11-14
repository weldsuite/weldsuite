/**
 * A recording turned into the compact text an AI summary reads (ADR PANEL-005,
 * docs/plans/weldpanel.md "AI").
 *
 * Only what the collector already stores masked: pages and the time on each,
 * the visible text of what was clicked or submitted (masked per the project's
 * masking level before it ever left the browser), frustration signals, error
 * messages and custom event names. Never an input value, a profile property, an
 * email, a name or the visitor's id: the model is told about "the visitor".
 * Custom event properties are left out too, since customers put whatever they
 * like in them.
 */

import type { PanelActivityEvent } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import type { PanelSessionRow } from '@weldsuite/app-api-client/schemas/weldpanel-query';

const MAX_LINES = 150;
const MAX_CHARS = 8000;
const MAX_TEXT = 80;
const MAX_ERROR = 160;

const FRUSTRATION_LABELS: Record<string, string> = {
  $rageclick: 'rage click (three or more fast clicks)',
  $deadclick: 'dead click (nothing happened)',
  $quickback: 'went straight back to the previous page',
  $excessivescroll: 'scrolled up and down a lot',
};

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function clock(ms: number): string {
  const total = Math.max(Math.round(ms / 1000), 0);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function span(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function quoted(detail: string | null): string {
  const text = detail ? clip(detail, MAX_TEXT) : '';
  return text === '' ? '(no visible text)' : `"${text}"`;
}

/** Header line: what kind of visit it was. No person, no ids. */
function header(session: PanelSessionRow): string {
  const parts = [
    `Duration ${span(session.durationSeconds)}`,
    `${session.pageviews} page${session.pageviews === 1 ? '' : 's'}`,
    `${session.clicks} click${session.clicks === 1 ? '' : 's'}`,
  ];
  const signals = [
    session.rageClicks > 0 ? `${session.rageClicks} rage click${session.rageClicks === 1 ? '' : 's'}` : null,
    session.deadClicks > 0 ? `${session.deadClicks} dead click${session.deadClicks === 1 ? '' : 's'}` : null,
    session.quickBacks > 0 ? `${session.quickBacks} quick back${session.quickBacks === 1 ? '' : 's'}` : null,
    session.errors > 0 ? `${session.errors} error${session.errors === 1 ? '' : 's'}` : null,
  ].filter((s): s is string => s !== null);
  if (signals.length > 0) parts.push(`signals: ${signals.join(', ')}`);
  const device = [session.deviceType, session.browser, session.os].filter((s): s is string => !!s).join(' / ');
  if (device) parts.push(`device: ${device}`);
  if (session.country) parts.push(`country: ${session.country}`);
  return parts.join(' · ');
}

/**
 * The timeline, oldest event first. `events` are the session's events as the
 * activity feed returns them (any order is accepted).
 */
export function buildSessionTimeline(session: PanelSessionRow, events: readonly PanelActivityEvent[]): string {
  const ordered = [...events].sort((a, b) => a.ts.localeCompare(b.ts) || a.eventId.localeCompare(b.eventId));
  const start = Date.parse(session.startedAt);
  const end = Date.parse(session.endedAt);
  const at = (ts: string) => clock(Date.parse(ts) - start);

  const lines: string[] = [];
  let currentPage: { line: number; ts: number } | null = null;
  const closePage = (untilMs: number) => {
    if (!currentPage) return;
    const seconds = Math.max(Math.round((untilMs - currentPage.ts) / 1000), 0);
    lines[currentPage.line] += ` (${span(seconds)} on the page)`;
    currentPage = null;
  };

  for (const event of ordered) {
    const when = Date.parse(event.ts);
    switch (event.name) {
      case '$pageview': {
        closePage(when);
        const title = event.title ? ` "${clip(event.title, MAX_TEXT)}"` : '';
        lines.push(`[${at(event.ts)}] Opened ${event.path ?? '(unknown page)'}${title}`);
        currentPage = { line: lines.length - 1, ts: when };
        break;
      }
      case '$autocapture': {
        const action = event.properties.$action === 'submit' ? 'Submitted a form via' : 'Clicked';
        lines.push(`[${at(event.ts)}] ${action} ${quoted(event.detail)}`);
        break;
      }
      case '$exception':
        lines.push(`[${at(event.ts)}] Error on the page: ${clip(event.detail ?? 'unknown error', MAX_ERROR)}`);
        break;
      default:
        if (FRUSTRATION_LABELS[event.name]) {
          const target = event.name === '$rageclick' || event.name === '$deadclick' ? ` on ${quoted(event.detail)}` : '';
          lines.push(`[${at(event.ts)}] Frustration: ${FRUSTRATION_LABELS[event.name]}${target}`);
        } else if (!event.name.startsWith('$')) {
          lines.push(`[${at(event.ts)}] Event "${clip(event.name, MAX_TEXT)}"`);
        }
    }
  }
  closePage(Number.isNaN(end) ? Date.now() : end);

  let body = lines;
  let omitted = 0;
  if (body.length > MAX_LINES) {
    // Keep the start and the end: how it began and where it ended matter most.
    const head = Math.floor(MAX_LINES * 0.6);
    const tail = MAX_LINES - head;
    omitted = body.length - MAX_LINES;
    body = [...body.slice(0, head), `... ${omitted} events left out ...`, ...body.slice(body.length - tail)];
  }
  let text = body.join('\n');
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}\n... cut ...`;

  const ending = session.exitPage ? `The visitor's last page was ${session.exitPage}.` : 'The last page is unknown.';
  return `${header(session)}\n${session.entryPage ? `Entry page: ${session.entryPage}\n` : ''}${ending}\n\nTimeline:\n${text || '(no events)'}`;
}
