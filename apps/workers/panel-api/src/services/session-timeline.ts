/**
 * A recording turned into the compact text an AI summary reads (ADR PANEL-005,
 * weldsuite-documentation/plans/weldpanel.md "AI").
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

function counted(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function signal(n: number, noun: string): string | null {
  return n > 0 ? counted(n, noun) : null;
}

/** Header line: what kind of visit it was. No person, no ids. */
function header(session: PanelSessionRow): string {
  const parts = [`Duration ${span(session.durationSeconds)}`, counted(session.pageviews, 'page'), counted(session.clicks, 'click')];
  const signals = [
    signal(session.rageClicks, 'rage click'),
    signal(session.deadClicks, 'dead click'),
    signal(session.quickBacks, 'quick back'),
    signal(session.errors, 'error'),
  ].filter((s): s is string => s !== null);
  if (signals.length > 0) parts.push(`signals: ${signals.join(', ')}`);
  const device = [session.deviceType, session.browser, session.os].filter((s): s is string => !!s).join(' / ');
  if (device) parts.push(`device: ${device}`);
  if (session.country) parts.push(`country: ${session.country}`);
  return parts.join(' · ');
}

/** The line for an event that is not a page view, or null when it is not worth a line. */
function eventLine(event: PanelActivityEvent, stamp: string): string | null {
  if (event.name === '$autocapture') {
    const action = event.properties.$action === 'submit' ? 'Submitted a form via' : 'Clicked';
    return `[${stamp}] ${action} ${quoted(event.detail)}`;
  }
  if (event.name === '$exception') return `[${stamp}] Error on the page: ${clip(event.detail ?? 'unknown error', MAX_ERROR)}`;
  const label = FRUSTRATION_LABELS[event.name];
  if (label) {
    const target = event.name === '$rageclick' || event.name === '$deadclick' ? ` on ${quoted(event.detail)}` : '';
    return `[${stamp}] Frustration: ${label}${target}`;
  }
  if (!event.name.startsWith('$')) return `[${stamp}] Event "${clip(event.name, MAX_TEXT)}"`;
  return null;
}

/** Keeps the start and the end of a long timeline: how it began and where it ended matter most. */
function limitLines(lines: string[]): string[] {
  if (lines.length <= MAX_LINES) return lines;
  const head = Math.floor(MAX_LINES * 0.6);
  const tail = MAX_LINES - head;
  const omitted = lines.length - MAX_LINES;
  return [...lines.slice(0, head), `... ${omitted} events left out ...`, ...lines.slice(lines.length - tail)];
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
    if (event.name === '$pageview') {
      closePage(when);
      const title = event.title ? ` "${clip(event.title, MAX_TEXT)}"` : '';
      lines.push(`[${at(event.ts)}] Opened ${event.path ?? '(unknown page)'}${title}`);
      currentPage = { line: lines.length - 1, ts: when };
    } else {
      const line = eventLine(event, at(event.ts));
      if (line !== null) lines.push(line);
    }
  }
  closePage(Number.isNaN(end) ? Date.now() : end);

  let text = limitLines(lines).join('\n');
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}\n... cut ...`;

  const ending = session.exitPage ? `The visitor's last page was ${session.exitPage}.` : 'The last page is unknown.';
  const entry = session.entryPage ? `Entry page: ${session.entryPage}\n` : '';
  return `${header(session)}\n${entry}${ending}\n\nTimeline:\n${text || '(no events)'}`;
}
