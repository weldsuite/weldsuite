/**
 * WeldPanel alert and scheduled-report copy, shared by the email templates
 * (./alert.tsx, ./report-digest.tsx) and panel-api's other channels (Slack,
 * WeldChat, in-app), so every channel says the same thing in the same words.
 * Plain text only; the templates add the markup.
 */

import { emailStrings, fill, intlLocale, type EmailLocale } from '../../i18n';

export type PanelAlertEvent = 'fired' | 'resolved' | 'test';
export type PanelAlertInterval = 'hourly' | 'daily' | 'weekly';

export type PanelAlertConditionText =
  | { type: 'threshold'; operator: 'above' | 'below'; value: number }
  | { type: 'change'; direction: 'increase' | 'decrease' | 'any'; percent: number }
  | { type: 'anomaly'; sensitivity: 'low' | 'medium' | 'high' };

export interface PanelAlertEmailProps {
  alertName: string;
  projectName: string;
  event: PanelAlertEvent;
  /** The series watched, as its report names it. */
  metric: string;
  /** The value of the period checked; null for a test without a check yet. */
  value: number | null;
  /** The bound it crossed (threshold, the change limit, the anomaly band edge). */
  bound: number | null;
  condition: PanelAlertConditionText;
  interval: PanelAlertInterval;
  /** The period checked as the query labels it: `2026-11-16` (a day, or the Monday of a week) or `2026-11-16T10:00` (an hour), in the alert's timezone. */
  period: string | null;
  /** Absolute link to the alert. */
  url: string;
}

export type PanelDigestFormat = 'number' | 'percent';

export interface PanelDigestFigure {
  label: string;
  value: number | null;
  /** The same figure for the period before; null when not compared. */
  previous: number | null;
  format: PanelDigestFormat;
}

export interface PanelDigestRow {
  label: string;
  value: number;
  format: PanelDigestFormat;
}

export interface PanelDigestBlock {
  title: string;
  headline: PanelDigestFigure[];
  /** Top rows (pages, steps, breakdown values), at most 10. */
  rows: PanelDigestRow[];
  /** The report could not be run; the block says so instead of numbers. */
  failed?: boolean;
  /** A kind of report the message cannot summarise: the block only links to it. */
  openOnly?: boolean;
  /** Absolute link to the report. */
  url?: string | null;
}

export interface PanelReportDigestEmailProps {
  subscriptionName: string;
  projectName: string;
  targetType: 'report' | 'dashboard';
  targetName: string;
  blocks: PanelDigestBlock[];
  /** Report tiles of the dashboard that did not fit (at most 12 are sent). */
  moreCount?: number;
  /** Absolute link to the report or dashboard. */
  url: string;
}

/** `1,234` / `1.234`, `12.5%` / `12,5%`. */
export function formatPanelValue(value: number | null, format: PanelDigestFormat, locale: EmailLocale): string {
  if (value === null || !Number.isFinite(value)) return '–';
  if (format === 'percent') {
    return new Intl.NumberFormat(intlLocale(locale), { style: 'percent', maximumFractionDigits: 1 }).format(value);
  }
  return new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 2 }).format(value);
}

/** `+12%`, `-3%`, "no change" or "new"; null when there is nothing to compare. */
export function formatPanelChange(figure: PanelDigestFigure, locale: EmailLocale): string | null {
  const t = emailStrings(locale).panel.reportDigest;
  if (figure.value === null || figure.previous === null) return null;
  if (figure.format === 'percent') {
    const points = Math.round((figure.value - figure.previous) * 1000) / 10;
    if (points === 0) return t.noChange;
    return `${points > 0 ? '+' : '-'}${formatPanelValue(Math.abs(points) / 100, 'percent', locale)}`;
  }
  if (figure.previous === 0) return figure.value === 0 ? t.noChange : t.newValue;
  const percent = Math.round(((figure.value - figure.previous) / Math.abs(figure.previous)) * 100);
  if (percent === 0) return t.noChange;
  return `${percent > 0 ? '+' : '-'}${Math.abs(percent)}%`;
}

/** The period an alert checked, as a reader says it. */
export function formatAlertPeriod(period: string | null, interval: PanelAlertInterval, locale: EmailLocale): string {
  if (!period) return '';
  const t = emailStrings(locale).panel.alert;
  const hour = /^(\d{4}-\d{2}-\d{2})T(\d{2}):00$/.exec(period);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(period) ? period : hour?.[1];
  if (!day) return period;
  const date = new Intl.DateTimeFormat(intlLocale(locale), { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
  if (hour) return `${date} ${hour[2]}:00`;
  return interval === 'weekly' ? fill(t.weekOf, { date }) : date;
}

/** "above 100", "up 20% or more on the period before", "outside the expected range (medium sensitivity)". */
export function alertConditionText(condition: PanelAlertConditionText, locale: EmailLocale): string {
  const t = emailStrings(locale).panel.alert;
  const number = (v: number) => formatPanelValue(v, 'number', locale);
  if (condition.type === 'threshold') return fill(condition.operator === 'above' ? t.conditionAbove : t.conditionBelow, { value: number(condition.value) });
  if (condition.type === 'change') {
    const template = { increase: t.conditionIncrease, decrease: t.conditionDecrease, any: t.conditionAny }[condition.direction];
    return fill(template, { percent: number(condition.percent) });
  }
  return `${t.conditionAnomaly} (${t.sensitivity[condition.sensitivity]})`;
}

export interface PanelMessageText {
  /** Subject line / message title. */
  title: string;
  /** One or two sentences. */
  body: string;
}

/** An alert message as text, for every channel. */
export function panelAlertText(props: PanelAlertEmailProps, locale: EmailLocale): PanelMessageText {
  const t = emailStrings(locale).panel.alert;
  const values = {
    alert: props.alertName,
    metric: props.metric,
    value: props.value === null ? t.noData : formatPanelValue(props.value, 'number', locale),
    period: formatAlertPeriod(props.period, props.interval, locale),
    condition: alertConditionText(props.condition, locale),
  };
  if (props.event === 'test') return { title: fill(t.headingTest, values), body: t.bodyTest };
  if (props.event === 'resolved') return { title: fill(t.headingResolved, values), body: fill(t.bodyResolved, values) };
  return { title: fill(t.headingFired, values), body: fill(t.bodyFired, values) };
}

/** A figure as one line: `Visitors: 1,234 (+12%)`. */
export function digestFigureText(figure: PanelDigestFigure, locale: EmailLocale): string {
  const change = formatPanelChange(figure, locale);
  const value = formatPanelValue(figure.value, figure.format, locale);
  return change ? `${figure.label}: ${value} (${change})` : `${figure.label}: ${value}`;
}

/** A scheduled report as text: a title and one line per figure and row, block by block. */
export function panelDigestText(props: PanelReportDigestEmailProps, locale: EmailLocale): PanelMessageText & { lines: string[] } {
  const t = emailStrings(locale).panel.reportDigest;
  const lines: string[] = [];
  for (const block of props.blocks) {
    lines.push(block.title);
    if (block.failed) lines.push(`  ${t.failed}`);
    else if (block.openOnly) lines.push(`  ${t.openToSee}`);
    else if (block.headline.length === 0 && block.rows.length === 0) lines.push(`  ${t.noData}`);
    for (const figure of block.headline) lines.push(`  ${digestFigureText(figure, locale)}`);
    for (const row of block.rows) lines.push(`  ${row.label}: ${formatPanelValue(row.value, row.format, locale)}`);
  }
  if (props.moreCount) lines.push(fill(t.more, { count: props.moreCount }));
  return {
    title: fill(t.subject, { name: props.subscriptionName, target: props.targetName }),
    body: fill(t.preview, { target: props.targetName }),
    lines,
  };
}
