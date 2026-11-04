/**
 * Status report rules: the colour of each area and of the report, the period
 * and the slots a project's cadence reports on, how a refresh merges the
 * computed parts with what the project manager wrote, and the shapes a report
 * takes on the wire and in entity events (design:
 * weldflow-delivery-and-portfolio.md, ADR FLOW-018).
 *
 * Pure functions, no database and no Hono context. The flow-api routes and the
 * `status_report_due` sweep use them, and the Rust flow-domain mirrors them
 * (rust/crates/flow-domain/src/status_report.rs). Every message returned here
 * is sent to the client as it is, so the two backends answer alike.
 *
 * What a colour means is a code, not a sentence: the area's `computed` says
 * `schedule.behind` with its parameters, and the UI (and later the portal)
 * turns that into text in the reader's language.
 */

import type { schema } from '@weldsuite/worker-kit/db';
import {
  STATUS_REPORT_AREAS,
  type StatusAreaComputed,
  type StatusColour,
  type StatusReport,
  type StatusReportArea as WireArea,
  type StatusReportAreaKey,
  type StatusReportCadence,
  type StatusReportSettings,
  type StatusReportSnapshot,
  type StatusReportSummary,
  type ResolvedRecipient,
} from '@weldsuite/app-api-client/schemas/project-reporting';

export { STATUS_REPORT_AREAS };
export type { StatusColour, StatusReportAreaKey };

type StatusReportRow = typeof schema.projectStatusReports.$inferSelect;

/** The layout version of `snapshot`: a report published under an older one still renders. */
export const SNAPSHOT_VERSION = 1;

const DAY_MS = 86_400_000;

// ── Thresholds ──────────────────────────────────────────────────────────────

/** Go-live this many calendar days late or more is red; any slip below it is amber. */
export const GO_LIVE_RED_DAYS = 7;
/** A milestone or deliverable more than this many days late is red, even when go-live holds. */
export const SCHEDULE_ITEM_RED_DAYS = 14;
/** Cost performance index below this is amber, below the next one red. */
export const CPI_AMBER_BELOW = 0.95;
export const CPI_RED_BELOW = 0.85;
/** A forecast over budget by more than this share is red; any overrun is amber. */
export const FORECAST_RED_OVER = 0.1;
/** This many pending change requests or more is red; one or two are amber. */
export const SCOPE_RED_PENDING = 3;
/** The score from which a risk is critical (the band above high). */
export const CRITICAL_SCORE = 17;
/** A benefit this far behind where the clock says it should be is amber, and red past the second. */
export const BENEFIT_AMBER_GAP = 0.1;
export const BENEFIT_RED_GAP = 0.25;
/** The lists of a report. */
export const TOP_RISKS = 3;
export const DECISIONS_LISTED = 5;
export const CHANGES_LISTED = 5;
export const MILESTONES_LISTED = 10;
export const ITEMS_LISTED = 10;

// ── Days ────────────────────────────────────────────────────────────────────

/** 00:00 UTC of the day `date` falls on. */
export function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** Whole UTC days from `from` to `to` (negative when `to` is earlier). */
export function dayDiff(from: Date, to: Date): number {
  return Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / DAY_MS);
}

/** ISO weekday of a date: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(date: Date): number {
  const day = date.getUTCDay();
  return day === 0 ? 7 : day;
}

/** The ISO 8601 week a date falls in (week 1 holds the year's first Thursday). */
export function isoWeek(date: Date): { year: number; week: number } {
  const day = startOfDay(date);
  // The Thursday of this week decides the year.
  const thursday = addDays(day, 4 - isoWeekday(day));
  const year = thursday.getUTCFullYear();
  const firstDay = new Date(Date.UTC(year, 0, 1));
  const week = Math.floor(dayDiff(firstDay, thursday) / 7) + 1;
  return { year, week };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** `2026-W45`. */
export function weekPeriod(date: Date): string {
  const { year, week } = isoWeek(date);
  return `${year}-W${pad2(week)}`;
}

/** `2026-11`. */
export function monthPeriod(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`;
}

/** Calendar days a report of this period looks back and forward over, for its done and planned lists. */
export function windowDays(period: string, cadence: StatusReportCadence | null): number {
  if (period.includes('W')) return cadence === 'biweekly' ? 14 : 7;
  return 31;
}

// ── Slots: when a cadence drafts its report ─────────────────────────────────

/**
 * A project's reporting slots are days (00:00 UTC): weekly on the weekday,
 * biweekly on the weekday of the even ISO weeks, monthly on the first working
 * day. The sweep runs once a day, so a draft appears on the slot day; `hour`
 * is the time the report is due to go out, which the app shows.
 */
export function isSlotDay(settings: Pick<StatusReportSettings, 'cadence' | 'weekday'>, day: Date): boolean {
  const weekday = isoWeekday(day);
  if (settings.cadence === 'monthly') {
    const dayOfMonth = day.getUTCDate();
    return weekday <= 5 && (dayOfMonth === 1 || (weekday === 1 && dayOfMonth <= 3));
  }
  if (weekday !== settings.weekday) return false;
  return settings.cadence === 'weekly' || isoWeek(day).week % 2 === 0;
}

const SLOT_SEARCH_DAYS = 62;

/** The latest slot day at or before `now` (00:00 UTC of it). */
export function lastSlotOnOrBefore(settings: Pick<StatusReportSettings, 'cadence' | 'weekday'>, now: Date): Date {
  let day = startOfDay(now);
  for (let i = 0; i < SLOT_SEARCH_DAYS; i++) {
    if (isSlotDay(settings, day)) return day;
    day = addDays(day, -1);
  }
  return startOfDay(now);
}

/** The first slot day after `now`. */
export function nextSlotAfter(settings: Pick<StatusReportSettings, 'cadence' | 'weekday'>, now: Date): Date {
  let day = addDays(startOfDay(now), 1);
  for (let i = 0; i < SLOT_SEARCH_DAYS; i++) {
    if (isSlotDay(settings, day)) return day;
    day = addDays(day, 1);
  }
  return addDays(startOfDay(now), 1);
}

/**
 * The period a slot's report covers: the ISO week the day before the slot
 * falls in (a Monday report is about the week that just ended), or for a
 * monthly cadence the month before the slot's month.
 */
export function periodForSlot(cadence: StatusReportCadence, slot: Date): string {
  if (cadence === 'monthly') return monthPeriod(new Date(Date.UTC(slot.getUTCFullYear(), slot.getUTCMonth() - 1, 1)));
  return weekPeriod(addDays(slot, -1));
}

/**
 * The period `POST /` reports on when the body names none: the report the
 * cadence sends next (the period of its next slot), or the current ISO week
 * without a schedule. A report written on Wednesday is the one that goes out
 * on Monday.
 */
export function defaultPeriod(settings: StatusReportSettings | null, now: Date): string {
  if (!settings) return weekPeriod(now);
  return periodForSlot(settings.cadence, nextSlotAfter(settings, now));
}

// ── Area colours ────────────────────────────────────────────────────────────

export interface AreaResult {
  colour: StatusColour;
  code: string;
  params: Record<string, unknown>;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

const COLOUR_RANK: Readonly<Record<StatusColour, number>> = { grey: 0, green: 1, amber: 2, red: 3 };

/** The worse of two colours (grey, "no data", is never worse than a real one). */
export function worstColour(colours: readonly StatusColour[]): StatusColour {
  let worst: StatusColour = 'grey';
  for (const colour of colours) if (COLOUR_RANK[colour] > COLOUR_RANK[worst]) worst = colour;
  return worst;
}

/** The report's suggested overall colour: the worst of its areas, grey when none has data. */
export function overallColour(areas: readonly Pick<AreaResult, 'colour'>[]): StatusColour {
  return worstColour(areas.map((area) => area.colour));
}

// -- Schedule -----------------------------------------------------------------

export interface ScheduleItem {
  kind: 'milestone' | 'deliverable' | 'go_live';
  id: string | null;
  name: string;
  /** What the latest baseline froze; null for an item added since. */
  baseline: Date | null;
  /** The date the plan has now. */
  current: Date | null;
  /** Completed or accepted: no longer part of the forecast. */
  done: boolean;
}

export interface ScheduleRow {
  kind: string;
  id: string | null;
  name: string;
  baselineDate: string | null;
  forecastDate: string | null;
  varianceDays: number | null;
}

/**
 * The schedule area: how far the plan has moved from the latest baseline.
 * An open item whose date has passed is forecast for today (it is late
 * already). Returns the area and the rows of the milestone table, earliest
 * baseline first.
 */
export function scheduleArea(
  baselineVersion: number | null,
  items: readonly ScheduleItem[],
  asOf: Date,
): { area: AreaResult; rows: ScheduleRow[] } {
  const open = items.filter((item) => !item.done && (item.current !== null || item.baseline !== null));
  const rows = open
    .map((item) => {
      const forecast = item.current ?? item.baseline;
      const slipped = forecast !== null && dayDiff(asOf, forecast) < 0 ? startOfDay(asOf) : forecast;
      const variance = item.baseline !== null && slipped !== null ? dayDiff(item.baseline, slipped) : null;
      return { item, forecast: slipped, variance };
    })
    .sort((a, b) => {
      const left = a.item.baseline?.getTime() ?? Number.POSITIVE_INFINITY;
      const right = b.item.baseline?.getTime() ?? Number.POSITIVE_INFINITY;
      return left - right;
    });
  const listed: ScheduleRow[] = rows.slice(0, MILESTONES_LISTED).map(({ item, forecast, variance }) => ({
    kind: item.kind,
    id: item.id,
    name: item.name,
    baselineDate: item.baseline ? item.baseline.toISOString() : null,
    forecastDate: forecast ? forecast.toISOString() : null,
    varianceDays: variance,
  }));
  if (baselineVersion === null) {
    return { area: { colour: 'grey', code: 'schedule.no_baseline', params: {} }, rows: listed };
  }

  const goLive = rows.find((row) => row.item.kind === 'go_live');
  const goLiveDays = goLive?.variance ?? null;
  let worstDays = 0;
  let worstName: string | null = null;
  let behindCount = 0;
  for (const row of rows) {
    if (row.variance === null || row.variance <= 0) continue;
    behindCount += 1;
    if (row.variance > worstDays) {
      worstDays = row.variance;
      worstName = row.item.name;
    }
  }
  let colour: StatusColour = 'green';
  if ((goLiveDays !== null && goLiveDays > GO_LIVE_RED_DAYS) || worstDays > SCHEDULE_ITEM_RED_DAYS) colour = 'red';
  else if (worstDays > 0) colour = 'amber';
  const area: AreaResult =
    colour === 'green'
      ? { colour, code: 'schedule.on_track', params: { baselineVersion } }
      : { colour, code: 'schedule.behind', params: { baselineVersion, worstDays, worstName, behindCount, goLiveDays } };
  return { area, rows: listed };
}

// -- Budget -------------------------------------------------------------------

/** The latest `project_finance_snapshots` row, numeric columns as the database returns them. */
export interface FinanceFigures {
  week: string;
  budget: string | null;
  plannedValue: string;
  earnedValue: string;
  actualCost: string;
  forecast: string | null;
}

export interface BudgetFigures extends FinanceFigures {
  cpi: number | null;
  spi: number | null;
}

/** CPI = EV / AC and SPI = EV / PV, rounded to two decimals; null while the divisor is zero. */
export function budgetFigures(finance: FinanceFigures): BudgetFigures {
  const earned = Number(finance.earnedValue);
  const actual = Number(finance.actualCost);
  const planned = Number(finance.plannedValue);
  return {
    ...finance,
    cpi: actual > 0 ? round2(earned / actual) : null,
    spi: planned > 0 ? round2(earned / planned) : null,
  };
}

/** The budget area: cost performance and the forecast against the budget. Grey without a finance snapshot. */
export function budgetArea(finance: FinanceFigures | null, currency: string | null): { area: AreaResult; figures: BudgetFigures | null } {
  if (!finance) return { area: { colour: 'grey', code: 'budget.no_data', params: {} }, figures: null };
  const figures = budgetFigures(finance);
  const earned = Number(finance.earnedValue);
  const actual = Number(finance.actualCost);
  const cpi = actual > 0 ? earned / actual : null;
  const budget = finance.budget === null ? null : Number(finance.budget);
  const forecast = finance.forecast === null ? null : Number(finance.forecast);
  const overrun = budget !== null && budget > 0 && forecast !== null ? (forecast - budget) / budget : null;
  let colour: StatusColour = 'green';
  if ((cpi !== null && cpi < CPI_RED_BELOW) || (overrun !== null && overrun > FORECAST_RED_OVER)) colour = 'red';
  else if ((cpi !== null && cpi < CPI_AMBER_BELOW) || (overrun !== null && overrun > 0)) colour = 'amber';
  const params = {
    week: finance.week,
    cpi: figures.cpi,
    budget: finance.budget,
    forecast: finance.forecast,
    actualCost: finance.actualCost,
    earnedValue: finance.earnedValue,
    currency,
  };
  return { area: { colour, code: colour === 'green' ? 'budget.on_budget' : 'budget.over', params }, figures };
}

// -- Scope --------------------------------------------------------------------

/** The scope area: change requests waiting for an answer. */
export function scopeArea(pendingCount: number): AreaResult {
  if (pendingCount === 0) return { colour: 'green', code: 'scope.none_pending', params: {} };
  return { colour: pendingCount >= SCOPE_RED_PENDING ? 'red' : 'amber', code: 'scope.pending', params: { count: pendingCount } };
}

// -- Risk ---------------------------------------------------------------------

export interface OpenRisk {
  id: string;
  code: string;
  title: string;
  score: number;
}

/** The risk area: the highest open score against the project's appetite. Critical and above appetite is red. */
export function riskArea(risks: readonly OpenRisk[], appetite: number): AreaResult {
  if (risks.length === 0) return { colour: 'green', code: 'risk.no_open_risks', params: {} };
  const highest = risks.reduce((top, risk) => (risk.score > top.score ? risk : top), risks[0] as OpenRisk);
  if (highest.score <= appetite) {
    return { colour: 'green', code: 'risk.within_appetite', params: { highest: highest.score, code: highest.code, appetite } };
  }
  const aboveCount = risks.filter((risk) => risk.score > appetite).length;
  return {
    colour: highest.score >= CRITICAL_SCORE ? 'red' : 'amber',
    code: 'risk.above_appetite',
    params: { highest: highest.score, code: highest.code, appetite, aboveCount },
  };
}

// -- Benefits -----------------------------------------------------------------

export interface BenefitInput {
  code: string;
  status: string;
  baseline: number | null;
  target: number | null;
  /** The latest measurement. */
  latest: number | null;
  createdAt: Date;
  realiseBy: Date | null;
}

/** How far a benefit is from its target: 0 at the baseline, 1 at the target. Null without the three figures. */
export function benefitProgress(benefit: Pick<BenefitInput, 'baseline' | 'target' | 'latest'>): number | null {
  const { baseline, target, latest } = benefit;
  if (baseline === null || target === null || latest === null || baseline === target) return null;
  return Math.max(0, (latest - baseline) / (target - baseline));
}

/** How far along a benefit should be by `asOf`, from its creation to its realise-by date; 0 without a date. */
export function benefitExpected(benefit: Pick<BenefitInput, 'createdAt' | 'realiseBy'>, asOf: Date): number {
  if (!benefit.realiseBy) return 0;
  const span = benefit.realiseBy.getTime() - benefit.createdAt.getTime();
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (asOf.getTime() - benefit.createdAt.getTime()) / span));
}

/** The benefits area: the open benefits' latest measurements against where the clock says they should be. */
export function benefitsArea(benefits: readonly BenefitInput[], asOf: Date): AreaResult {
  if (benefits.length === 0) return { colour: 'grey', code: 'benefits.none', params: {} };
  const measured = benefits.filter((benefit) => benefitProgress(benefit) !== null);
  if (measured.length === 0) return { colour: 'grey', code: 'benefits.no_measurements', params: { count: benefits.length } };
  let colour: StatusColour = 'green';
  let behind = 0;
  let worstCode: string | null = null;
  let worstGap = 0;
  for (const benefit of measured) {
    const progress = benefitProgress(benefit) ?? 0;
    const gap = benefit.status === 'realised' ? 0 : benefitExpected(benefit, asOf) - progress;
    let own: StatusColour = 'green';
    if (gap > BENEFIT_RED_GAP) own = 'red';
    else if (gap > BENEFIT_AMBER_GAP || benefit.status === 'at_risk') own = 'amber';
    if (own !== 'green') behind += 1;
    colour = worstColour([colour, own]);
    if (gap > worstGap) {
      worstGap = gap;
      worstCode = benefit.code;
    }
  }
  return colour === 'green'
    ? { colour, code: 'benefits.on_track', params: { count: measured.length } }
    : { colour, code: 'benefits.behind', params: { count: measured.length, behind, worstCode } };
}

// ── Draft building ──────────────────────────────────────────────────────────

/** The five computed areas of a report. */
export type ComputedAreas = Record<StatusReportAreaKey, AreaResult>;

/** `computed.areas` of the snapshot: the codes behind each colour. */
export function computedAreasOf(areas: ComputedAreas): Record<string, StatusAreaComputed> {
  const out: Record<string, StatusAreaComputed> = {};
  for (const key of STATUS_REPORT_AREAS) out[key] = { colour: areas[key].colour, code: areas[key].code, params: areas[key].params };
  return out;
}

/**
 * The areas of a draft after the data was (re)computed: an area the project
 * manager overrode keeps the override (colour and reason), every other area
 * takes the computed colour.
 */
export function mergeAreas(existing: readonly schema.StatusReportArea[] | null, computed: ComputedAreas): schema.StatusReportArea[] {
  return STATUS_REPORT_AREAS.map((key) => {
    const own = existing?.find((area) => area.key === key);
    if (own && !own.auto) return { key, colour: own.colour, reason: own.reason, auto: false };
    return { key, colour: computed[key].colour, reason: null, auto: true };
  });
}

/**
 * The overall colour after a refresh: the project manager's own while it
 * differs from what the data last suggested, else the new suggestion.
 */
export function mergeOverall(
  current: StatusColour | null,
  previousSuggestion: StatusColour | null,
  suggestion: StatusColour,
): StatusColour {
  if (current === null || current === previousSuggestion) return suggestion;
  return current;
}

/** True for a line the report filled in from project data: it carries a code. */
export function isFilledIn(item: schema.StatusReportItem): boolean {
  return item.code !== null && item.code !== undefined;
}

/**
 * The done or next list after a refresh: the fresh lines the data gives, then
 * the lines the project manager wrote (they have no code and are kept).
 */
export function mergeItems(existing: readonly schema.StatusReportItem[], fresh: readonly schema.StatusReportItem[]): schema.StatusReportItem[] {
  return [...fresh, ...existing.filter((item) => !isFilledIn(item))];
}

/** A line of the done or next list as it is stored (every key present). */
export function storedItem(item: { taskId?: string | null; text: string; code?: string | null; date?: string | null }): schema.StatusReportItem {
  return {
    taskId: item.taskId ?? null,
    text: item.text,
    code: item.code ?? null,
    date: item.date ? new Date(item.date).toISOString() : null,
  };
}

// ── Recipients ──────────────────────────────────────────────────────────────

export interface RecipientCandidate {
  stakeholderId: string | null;
  userId: string | null;
  name: string | null;
  email: string | null;
  kind: 'member' | 'contact';
  portalAccess: boolean;
}

/** `recipients` as stored on a report. */
export interface StoredRecipients {
  stakeholderIds?: string[];
}

/**
 * Who a report goes to, given the stored list (null: the schedule's) and the
 * schedule. `sponsor` is the sponsor's own entry, outside the stakeholders.
 * The order is the order of the list, or of the register for a rule.
 */
export function recipientTargets(
  stored: StoredRecipients | null | undefined,
  schedule: Pick<StatusReportSettings, 'recipients'> | null,
  register: readonly RecipientCandidate[],
  sponsor: RecipientCandidate | null,
): RecipientCandidate[] {
  const ids = stored?.stakeholderIds ?? schedule?.recipients.stakeholderIds;
  if (ids !== undefined) {
    return ids.flatMap((id) => register.filter((candidate) => candidate.stakeholderId === id));
  }
  const rule = schedule?.recipients.rule ?? 'sponsor';
  if (rule === 'all_stakeholders') return [...register];
  if (rule === 'portal_contacts') return register.filter((candidate) => candidate.portalAccess && candidate.kind === 'contact');
  return sponsor ? [sponsor] : [];
}

// ── Messages ────────────────────────────────────────────────────────────────

/** `PATCH` and `DELETE` on a published report. */
export const PUBLISHED_IMMUTABLE = 'A published report cannot be changed';
export const SUMMARY_REQUIRED = 'Write a summary before publishing';
export const OVERALL_REQUIRED = 'Set an overall status before publishing';
export const PERIOD_DRAFT_EXISTS = 'A draft already exists for this period';

// ── Wire shapes ─────────────────────────────────────────────────────────────

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function presentItem(item: schema.StatusReportItem): StatusReport['done'][number] {
  return { taskId: item.taskId ?? null, text: item.text, code: item.code ?? null, date: item.date ?? null };
}

/** `computed.areas` of a stored snapshot: what each area's colour said when the data was last read. */
export function snapshotComputedAreas(snapshot: schema.StatusReportSnapshot | null | undefined): Record<string, StatusAreaComputed> | null {
  const computed = snapshot?.computed as { areas?: Record<string, StatusAreaComputed> } | undefined;
  return computed?.areas ?? null;
}

/** The areas as the routes answer them, with what each computed colour said when the snapshot was taken. */
export function presentAreas(areas: readonly schema.StatusReportArea[], snapshot: schema.StatusReportSnapshot | null | undefined): WireArea[] {
  const computed = snapshotComputedAreas(snapshot);
  return areas.map((area) => ({
    key: area.key,
    colour: area.colour,
    reason: area.reason ?? null,
    auto: area.auto,
    computed: computed?.[area.key] ?? null,
  }));
}

export function presentStatusReportSummary(row: StatusReportRow, supersededById: string | null): StatusReportSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    period: row.period,
    status: row.status,
    overall: row.overall ?? null,
    areas: presentAreas(row.areas, row.snapshot),
    summary: row.summary ?? null,
    clientVisible: row.clientVisible,
    supersedesId: row.supersedesId ?? null,
    supersededById,
    publishedBy: row.publishedBy ?? null,
    publishedAt: iso(row.publishedAt),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function presentStatusReport(
  row: StatusReportRow,
  supersededById: string | null,
  resolvedRecipients: ResolvedRecipient[],
): StatusReport {
  return {
    ...presentStatusReportSummary(row, supersededById),
    done: row.done.map(presentItem),
    next: row.next.map(presentItem),
    snapshot: (row.snapshot ?? null) as StatusReportSnapshot | null,
    recipients: row.recipients?.stakeholderIds ? { stakeholderIds: row.recipients.stakeholderIds } : row.recipients ? {} : null,
    resolvedRecipients,
  };
}

/** What an entity event of a report carries. */
export function statusReportEventData(row: StatusReportRow): Record<string, unknown> {
  return {
    id: row.id,
    projectId: row.projectId,
    period: row.period,
    status: row.status,
    overall: row.overall ?? null,
    clientVisible: row.clientVisible,
    supersedesId: row.supersedesId ?? null,
    publishedAt: iso(row.publishedAt),
  };
}

/** `projects.health` for a published colour: the vocabulary the project list already reads. Grey leaves it alone. */
export function healthForColour(colour: StatusColour): string | null {
  switch (colour) {
    case 'green':
      return 'on_track';
    case 'amber':
      return 'at_risk';
    case 'red':
      return 'off_track';
    default:
      return null;
  }
}
