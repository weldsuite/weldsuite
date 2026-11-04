/**
 * Capacity rules: load per member and ISO week, free hours, suggestions for a
 * resource request, and the wire shapes of bookings, requests and profiles
 * (design: weldflow-delivery-and-portfolio.md, "Capacity").
 *
 * Pure functions, no database, no clock and no Hono context. flow-api's
 * `/api/capacity` and `/api/project-requests` routes use them, and the Rust
 * flow-domain (`capacity.rs`) mirrors them one to one. Every message returned
 * here is sent to the client as it is, so both backends answer alike.
 *
 * Dates are calendar dates (`YYYY-MM-DD`), handled as whole days since
 * 1970-01-01. Hours are plain numbers; every figure that is shown is rounded
 * to two decimals with `Math.round`, the same on both sides.
 *
 * Load per member and week
 * ------------------------
 *   load = bookings + the estimates of the member's open tasks
 *
 *   - A booking adds `hoursPerWeek × (working days of the week it covers ÷ 5)`.
 *     A tentative booking counts only when the view asks for tentative load.
 *   - An open task (not done, not cancelled, in a project) adds its estimate,
 *     split evenly over its assignees and spread evenly over its working
 *     days (Monday to Friday, from `startDate` to `dueDate`; a task with one
 *     of the two dates lands on that day, one with neither is not placed). A
 *     window with no working day puts the whole estimate in the week of its
 *     first day.
 *   - A task adds nothing in a week where the member has a booking on the
 *     task's project: the booking is that week's plan for it.
 *
 * Contract hours come from `flow_member_profiles.weekly_hours`, 40 without a
 * profile.
 */

import {
  CAPACITY_BANDS,
  DATE_PATTERN,
  DEFAULT_CAPACITY_WEEKS,
  DEFAULT_ROADMAP_QUARTERS,
  DEFAULT_WEEKLY_HOURS,
  MAX_CAPACITY_WEEKS,
  MAX_ROADMAP_QUARTERS,
  type CapacityBand,
  type CapacityCell,
  type CapacityTotals,
  type CapacityWeek,
  type MemberProfile,
  type MemberSuggestion,
  type NeededSkillInput,
  type ResourceBooking,
  type ResourceRequest,
  type RoadmapBucket,
  type SkillFit,
} from '@weldsuite/app-api-client/schemas/flow-portfolio';
import type { schema } from '@weldsuite/worker-kit/db';
import { compareText } from './compare';

export { CAPACITY_BANDS, DEFAULT_WEEKLY_HOURS, MAX_CAPACITY_WEEKS };
export type { CapacityBand };

/** The messages of every refusal, sent to the client as they are. */
export const CAPACITY_MESSAGES = {
  invalidDate: 'Use a real calendar date',
  periodOrder: 'The end date cannot be before the start date',
  rangeTooLong: `The range can span at most ${MAX_CAPACITY_WEEKS} weeks`,
  roadmapTooLong: `The roadmap spans at most ${MAX_ROADMAP_QUARTERS} quarters`,
  bookingTarget: 'A booking is for a project or for a request, not both and not neither',
  bookingForbidden: 'You do not have permission to book people on this',
  profileForbidden: 'You can only change your own profile',
  requestForbidden: 'You do not have permission to request people for this project',
  requestNotOpen: 'Only an open resource request can be changed',
  requestNotBookable: 'This resource request is no longer open',
  heldBookingTentative: 'A booking held for a request is always tentative',
  heldRequestClosed: 'This request is no longer open for bookings',
} as const;

// ── Dates ───────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
/** The years a date may have: a calendar the rules below hold for. */
const MIN_YEAR = 1970;
const MAX_YEAR = 2200;

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** The whole days since 1970-01-01 of a real `YYYY-MM-DD` date, or null. */
export function parseDate(text: string): number | null {
  const match = DATE_PATTERN.test(text) ? text.split('-') : null;
  if (!match) return null;
  const year = Number(match[0]);
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  const millis = Date.UTC(year, month - 1, day);
  const date = new Date(millis);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return millis / DAY_MS;
}

/** `YYYY-MM-DD` of a day number. */
export function formatDate(days: number): string {
  return new Date(days * DAY_MS).toISOString().slice(0, 10);
}

/** 0 for Monday to 6 for Sunday. */
export function weekdayOf(days: number): number {
  return mod(days + 3, 7);
}

/** The Monday of the ISO week that holds the day. */
export function mondayOf(days: number): number {
  return days - weekdayOf(days);
}

/** `2026-W45`: the ISO week of a Monday (the year is the one of its Thursday). */
export function isoWeekLabel(monday: number): string {
  const thursday = monday + 3;
  const year = new Date(thursday * DAY_MS).getUTCFullYear();
  const january1 = Date.UTC(year, 0, 1) / DAY_MS;
  const week = Math.floor((thursday - january1) / 7) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Working days (Monday to Friday) from the start of time up to and including the day. */
function workingDaysUpTo(days: number): number {
  const shifted = days + 3;
  return 5 * Math.floor(shifted / 7) + Math.min(mod(shifted, 7) + 1, 5);
}

/** Working days in `[from, to]`, both included; 0 when `to` is before `from`. */
export function workingDaysBetween(from: number, to: number): number {
  return to < from ? 0 : workingDaysUpTo(to) - workingDaysUpTo(from - 1);
}

/** Working days of the week starting on `monday` that `[from, to]` covers. */
function workingDaysInWeek(from: number, to: number, monday: number): number {
  const a = Math.max(from, monday);
  const b = Math.min(to, monday + 4);
  return b >= a ? b - a + 1 : 0;
}

/** `Math.round(value × 100) ÷ 100`: how every shown figure is rounded. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The 400 message for a booking's or request's period, or null: two real dates, the end not before the start. */
export function periodError(startsOn: string, endsOn: string): string | null {
  const start = parseDate(startsOn);
  const end = parseDate(endsOn);
  if (start === null || end === null) return CAPACITY_MESSAGES.invalidDate;
  return end < start ? CAPACITY_MESSAGES.periodOrder : null;
}

/** The 400 message for a booking's target, or null: a project or a request, exactly one of the two. */
export function bookingTargetError(target: { projectId?: string | null; requestId?: string | null }): string | null {
  return !!target.projectId === !!target.requestId ? CAPACITY_MESSAGES.bookingTarget : null;
}

// ── Ranges ──────────────────────────────────────────────────────────────────

export interface CapacityRange {
  /** The Monday of the first week. */
  from: string;
  /** The Sunday of the last week. */
  to: string;
  weeks: number;
}

/**
 * The weeks a capacity read covers: from the Monday of `from` (default: this
 * week) to the Sunday of `to` (default: 14 weeks after the start), at most 26
 * weeks. Returns the 400 message instead when a date is not real, the end is
 * before the start or the range is too long.
 */
export function capacityRange(from: string | undefined, to: string | undefined, today: string): CapacityRange | { error: string } {
  const todayDays = parseDate(today);
  if (todayDays === null) return { error: CAPACITY_MESSAGES.invalidDate };
  const fromDays = from === undefined ? todayDays : parseDate(from);
  if (fromDays === null) return { error: CAPACITY_MESSAGES.invalidDate };
  const first = mondayOf(fromDays);
  const toDays = to === undefined ? first + DEFAULT_CAPACITY_WEEKS * 7 - 1 : parseDate(to);
  if (toDays === null) return { error: CAPACITY_MESSAGES.invalidDate };
  if (toDays < fromDays) return { error: CAPACITY_MESSAGES.periodOrder };
  const weeks = (mondayOf(toDays) - first) / 7 + 1;
  if (weeks > MAX_CAPACITY_WEEKS) return { error: CAPACITY_MESSAGES.rangeTooLong };
  return { from: formatDate(first), to: formatDate(mondayOf(toDays) + 6), weeks };
}

/**
 * The weeks the capacity fit of a request looks at: from the Monday of its
 * desired start (default: this week) to the Sunday of its desired end,
 * at most 26 weeks (a later end is cut off; no end, or one before the start,
 * is the default 14 weeks).
 */
export function fitRange(desiredStart: string | null | undefined, desiredEnd: string | null | undefined, today: string): CapacityRange {
  const todayDays = parseDate(today) ?? 0;
  const startDays = desiredStart ? parseDate(desiredStart) : null;
  const first = mondayOf(startDays ?? todayDays);
  const endDays = desiredEnd ? parseDate(desiredEnd) : null;
  const longest = first + MAX_CAPACITY_WEEKS * 7 - 1;
  const last =
    endDays === null || endDays < first
      ? first + DEFAULT_CAPACITY_WEEKS * 7 - 1
      : Math.min(mondayOf(endDays) + 6, longest);
  return { from: formatDate(first), to: formatDate(last), weeks: (last - first + 1) / 7 };
}

/** The whole weeks that cover a roadmap range (the Monday of the first and the Sunday of the last), however many: only the team totals are read. */
export function weeksCovering(from: string, to: string): CapacityRange {
  const first = mondayOf(parseDate(from) ?? 0);
  const last = mondayOf(parseDate(to) ?? 0);
  return { from: formatDate(first), to: formatDate(last + 6), weeks: (last - first) / 7 + 1 };
}

/** The first day of the quarter that holds the day. */
function quarterStart(days: number): number {
  const date = new Date(days * DAY_MS);
  const month = Math.floor(date.getUTCMonth() / 3) * 3;
  return Date.UTC(date.getUTCFullYear(), month, 1) / DAY_MS;
}

/** The last day of the quarter that holds the day. */
function quarterEnd(days: number): number {
  const date = new Date(days * DAY_MS);
  const month = Math.floor(date.getUTCMonth() / 3) * 3 + 3;
  return Date.UTC(date.getUTCFullYear(), month, 1) / DAY_MS - 1;
}

export interface RoadmapRange {
  /** The first day of the first quarter. */
  from: string;
  /** The last day of the last quarter. */
  to: string;
  quarters: number;
}

/**
 * The quarters the roadmap covers: `from` and `to` widened to whole quarters
 * (default: this quarter and the next three), at most 8 quarters.
 */
export function roadmapRange(from: string | undefined, to: string | undefined, today: string): RoadmapRange | { error: string } {
  const todayDays = parseDate(today);
  if (todayDays === null) return { error: CAPACITY_MESSAGES.invalidDate };
  const fromDays = from === undefined ? todayDays : parseDate(from);
  if (fromDays === null) return { error: CAPACITY_MESSAGES.invalidDate };
  const first = quarterStart(fromDays);
  let last: number;
  if (to === undefined) {
    last = quarterEnd(first);
    for (let i = 1; i < DEFAULT_ROADMAP_QUARTERS; i++) last = quarterEnd(last + 1);
  } else {
    const toDays = parseDate(to);
    if (toDays === null) return { error: CAPACITY_MESSAGES.invalidDate };
    if (toDays < fromDays) return { error: CAPACITY_MESSAGES.periodOrder };
    last = quarterEnd(toDays);
  }
  let quarters = 1;
  for (let cursor = quarterEnd(first); cursor < last; cursor = quarterEnd(cursor + 1)) quarters += 1;
  if (quarters > MAX_ROADMAP_QUARTERS) return { error: CAPACITY_MESSAGES.roadmapTooLong };
  return { from: formatDate(first), to: formatDate(last), quarters };
}

// ── Inputs ──────────────────────────────────────────────────────────────────

/** A member as the load reads them. */
export interface CapacityMember {
  memberId: string;
  weeklyHours: number;
  skills: string[];
  hasProfile: boolean;
}

/** A booking that overlaps the range. */
export interface CapacityBooking {
  memberId: string;
  projectId: string | null;
  requestId: string | null;
  startsOn: string;
  endsOn: string;
  hoursPerWeek: number;
  tentative: boolean;
}

/** An open task with an estimate, as the load reads it. */
export interface CapacityTask {
  projectId: string;
  assigneeId: string | null;
  assigneeIds: string[] | null;
  startsOn: string | null;
  dueOn: string | null;
  estimatedHours: number;
}

export interface CapacityProfileInput {
  memberId: string;
  weeklyHours: number;
  skills: string[];
}

/** The people on a task: `assigneeIds`, else the one `assigneeId`; each once, in order. */
export function taskAssignees(task: Pick<CapacityTask, 'assigneeId' | 'assigneeIds'>): string[] {
  const listed = (task.assigneeIds ?? []).filter((id) => id.length > 0);
  const single = task.assigneeId ? [task.assigneeId] : [];
  const ids = listed.length > 0 ? listed : single;
  return [...new Set(ids)];
}

/**
 * The members the load lists: everyone with a profile, a booking or an open
 * task, plus `people` (the members of current projects), each once, by id. A
 * member without a profile gets 40 contract hours and no skills.
 */
export function collectMembers(input: {
  profiles: readonly CapacityProfileInput[];
  bookings: readonly Pick<CapacityBooking, 'memberId'>[];
  tasks: readonly Pick<CapacityTask, 'assigneeId' | 'assigneeIds'>[];
  people: readonly string[];
}): CapacityMember[] {
  const byId = new Map<string, CapacityMember>();
  for (const profile of input.profiles) {
    byId.set(profile.memberId, {
      memberId: profile.memberId,
      weeklyHours: profile.weeklyHours,
      skills: profile.skills,
      hasProfile: true,
    });
  }
  const ids = [...input.bookings.map((b) => b.memberId), ...input.tasks.flatMap(taskAssignees), ...input.people];
  for (const id of ids) {
    if (id.length > 0 && !byId.has(id)) {
      byId.set(id, { memberId: id, weeklyHours: DEFAULT_WEEKLY_HOURS, skills: [], hasProfile: false });
    }
  }
  return [...byId.values()].sort((a, b) => compareText(a.memberId, b.memberId));
}

/** A skill as it is compared: trimmed, lower case. */
export function normalizeSkill(skill: string): string {
  return skill.trim().toLowerCase();
}

/** A member's skills as stored: trimmed, each once (case aside), in the order given. */
export function normalizeSkills(skills: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const skill of skills) {
    const trimmed = skill.trim();
    const key = normalizeSkill(trimmed);
    if (key.length > 0 && !seen.has(key)) {
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out;
}

function hasSkill(member: Pick<CapacityMember, 'skills'>, skill: string): boolean {
  const wanted = normalizeSkill(skill);
  return member.skills.some((s) => normalizeSkill(s) === wanted);
}

// ── Load ────────────────────────────────────────────────────────────────────

export interface CapacityInput {
  /** Any day; the first week is the one that holds it. */
  from: string;
  weeks: number;
  members: readonly CapacityMember[];
  bookings: readonly CapacityBooking[];
  tasks: readonly CapacityTask[];
  includeTentative: boolean;
  /** Only members with this skill (case aside). */
  skill?: string;
}

/** One project or request in a member's load, before names are added. */
export interface LoadRow {
  projectId: string | null;
  requestId: string | null;
  hours: number[];
  tentativeHours: number[];
}

export interface MemberLoad {
  memberId: string;
  weeklyHours: number;
  skills: string[];
  hasProfile: boolean;
  cells: CapacityCell[];
  projects: LoadRow[];
}

export interface CapacityLoad {
  weeks: CapacityWeek[];
  totals: CapacityTotals[];
  members: MemberLoad[];
  summary: {
    memberCount: number;
    bookedHours: number;
    capacityHours: number;
    percent: number | null;
    overbookedPersonWeeks: number;
  };
}

/** Percent of contract hours, null without contract hours. */
export function loadPercent(hours: number, weeklyHours: number): number | null {
  return weeklyHours > 0 ? round2((hours / weeklyHours) * 100) : null;
}

/** The band of a week's load. */
export function capacityBand(hours: number, percent: number | null): CapacityBand {
  if (hours <= 0) return 'none';
  if (percent === null) return 'critical';
  if (percent < 50) return 'under';
  if (percent < 80) return 'ok';
  if (percent <= 100) return 'full';
  if (percent <= 120) return 'over';
  return 'critical';
}

function rowKey(projectId: string | null, requestId: string | null): string {
  return projectId ? `p:${projectId}` : `r:${requestId ?? ''}`;
}

interface Accumulator {
  projectId: string | null;
  requestId: string | null;
  hours: number[];
  tentative: number[];
}

type TaskShare = { task: CapacityTask; share: number };

function bookingsByMember(bookings: readonly CapacityBooking[], includeTentative: boolean): Map<string, CapacityBooking[]> {
  const byMember = new Map<string, CapacityBooking[]>();
  for (const booking of bookings) {
    if (booking.tentative && !includeTentative) continue;
    const list = byMember.get(booking.memberId);
    if (list) list.push(booking);
    else byMember.set(booking.memberId, [booking]);
  }
  return byMember;
}

function tasksByMember(tasks: readonly CapacityTask[]): Map<string, TaskShare[]> {
  const byMember = new Map<string, TaskShare[]>();
  for (const task of tasks) {
    const assignees = taskAssignees(task);
    for (const id of assignees) {
      const entry = { task, share: task.estimatedHours / assignees.length };
      const list = byMember.get(id);
      if (list) list.push(entry);
      else byMember.set(id, [entry]);
    }
  }
  return byMember;
}

/** Hours of a task in the week of `monday`; a window without a working day lands whole in the week of its first day. */
function taskHoursInWeek(share: number, workingDays: number, lo: number, hi: number, monday: number): number {
  if (workingDays !== 0) return (share / workingDays) * workingDaysInWeek(lo, hi, monday);
  return lo >= monday && lo <= monday + 6 ? share : 0;
}

function accumulateBooking(
  starts: readonly number[],
  booking: CapacityBooking,
  row: (projectId: string | null, requestId: string | null) => Accumulator,
  covered: Set<string>,
): void {
  const from = parseDate(booking.startsOn);
  const to = parseDate(booking.endsOn);
  if (from === null || to === null) return;
  starts.forEach((monday, i) => {
    const days = workingDaysInWeek(from, to, monday);
    if (days === 0) return;
    const acc = row(booking.projectId, booking.requestId);
    const hours = (booking.hoursPerWeek * days) / 5;
    acc.hours[i] += hours;
    if (booking.tentative) acc.tentative[i] += hours;
    if (booking.projectId) covered.add(`${booking.projectId}:${i}`);
  });
}

function accumulateTask(
  starts: readonly number[],
  { task, share }: TaskShare,
  row: (projectId: string | null, requestId: string | null) => Accumulator,
  covered: ReadonlySet<string>,
): void {
  const a = task.startsOn === null ? null : parseDate(task.startsOn);
  const b = task.dueOn === null ? null : parseDate(task.dueOn);
  const first = a ?? b;
  const last = b ?? a;
  if (first === null || last === null) return;
  const lo = Math.min(first, last);
  const hi = Math.max(first, last);
  const workingDays = workingDaysBetween(lo, hi);
  starts.forEach((monday, i) => {
    if (covered.has(`${task.projectId}:${i}`)) return;
    const hours = taskHoursInWeek(share, workingDays, lo, hi, monday);
    if (hours > 0) row(task.projectId, null).hours[i] += hours;
  });
}

/** One member's hours per project or request, in key order. */
function accumulateMemberHours(
  starts: readonly number[],
  bookings: readonly CapacityBooking[],
  tasks: readonly TaskShare[],
): Accumulator[] {
  const rows = new Map<string, Accumulator>();
  const row = (projectId: string | null, requestId: string | null): Accumulator => {
    const key = rowKey(projectId, requestId);
    let found = rows.get(key);
    if (!found) {
      found = { projectId, requestId, hours: starts.map(() => 0), tentative: starts.map(() => 0) };
      rows.set(key, found);
    }
    return found;
  };
  const covered = new Set<string>();
  for (const booking of bookings) accumulateBooking(starts, booking, row, covered);
  for (const task of tasks) accumulateTask(starts, task, row, covered);
  return [...rows.entries()].sort(([a], [b]) => compareText(a, b)).map(([, acc]) => acc);
}

function isOverbooked(cell: CapacityCell): boolean {
  return cell.percent === null ? cell.hours > 0 : cell.percent > 100;
}

function memberCells(
  starts: readonly number[],
  accumulators: readonly Accumulator[],
  member: CapacityMember,
  totals: CapacityTotals[],
): CapacityCell[] {
  return starts.map((_, i) => {
    let sum = 0;
    let tentativeSum = 0;
    for (const acc of accumulators) {
      sum += acc.hours[i];
      tentativeSum += acc.tentative[i];
    }
    const hours = round2(sum);
    const percent = loadPercent(hours, member.weeklyHours);
    const band = capacityBand(hours, percent);
    totals[i].bookedHours += hours;
    totals[i].capacityHours += member.weeklyHours;
    return { hours, tentativeHours: round2(tentativeSum), percent, band };
  });
}

/**
 * Load per member per week, with the projects behind it. Members are listed
 * as given (only those with `skill`, when it is set); the order of bookings
 * and tasks is the order the sums are added in, so callers read them in a fixed
 * order.
 */
export function computeCapacity(input: CapacityInput): CapacityLoad {
  const firstDay = mondayOf(parseDate(input.from) ?? 0);
  const starts = Array.from({ length: input.weeks }, (_, i) => firstDay + i * 7);
  const weeks: CapacityWeek[] = starts.map((monday) => ({
    week: isoWeekLabel(monday),
    startsOn: formatDate(monday),
    endsOn: formatDate(monday + 6),
  }));
  const members = input.skill === undefined ? input.members : input.members.filter((m) => hasSkill(m, input.skill ?? ''));

  const bookingsOf = bookingsByMember(input.bookings, input.includeTentative);
  const tasksOf = tasksByMember(input.tasks);

  const loads: MemberLoad[] = [];
  const totals: CapacityTotals[] = starts.map(() => ({ bookedHours: 0, capacityHours: 0 }));
  let overbooked = 0;
  for (const member of members) {
    const accumulators = accumulateMemberHours(
      starts,
      bookingsOf.get(member.memberId) ?? [],
      tasksOf.get(member.memberId) ?? [],
    );
    const cells = memberCells(starts, accumulators, member, totals);
    overbooked += cells.filter(isOverbooked).length;
    loads.push({
      memberId: member.memberId,
      weeklyHours: member.weeklyHours,
      skills: member.skills,
      hasProfile: member.hasProfile,
      cells,
      projects: accumulators
        .map((acc) => ({
          projectId: acc.projectId,
          requestId: acc.requestId,
          hours: acc.hours.map(round2),
          tentativeHours: acc.tentative.map(round2),
        }))
        .filter((r) => r.hours.some((h) => h > 0)),
    });
  }

  const roundedTotals = totals.map((t) => ({ bookedHours: round2(t.bookedHours), capacityHours: round2(t.capacityHours) }));
  const bookedHours = round2(roundedTotals.reduce((sum, t) => sum + t.bookedHours, 0));
  const capacityHours = round2(roundedTotals.reduce((sum, t) => sum + t.capacityHours, 0));
  return {
    weeks,
    totals: roundedTotals,
    members: loads,
    summary: {
      memberCount: loads.length,
      bookedHours,
      capacityHours,
      percent: capacityHours > 0 ? round2((bookedHours / capacityHours) * 100) : null,
      overbookedPersonWeeks: overbooked,
    },
  };
}

// ── Suggestions and fit ─────────────────────────────────────────────────────

/** Free hours of a member in each week of the load that overlaps `[startsOn, endsOn]`. */
function freeHoursOver(member: MemberLoad, weeks: readonly CapacityWeek[], startsOn: string, endsOn: string): number[] {
  const from = parseDate(startsOn);
  const to = parseDate(endsOn);
  if (from === null || to === null) return [];
  const free: number[] = [];
  weeks.forEach((week, i) => {
    const monday = parseDate(week.startsOn) ?? 0;
    if (from <= monday + 6 && to >= monday) {
      free.push(round2(Math.max(0, member.weeklyHours - member.cells[i].hours)));
    }
  });
  return free;
}

/**
 * People for a resource request: members with the skill, with the hours they
 * have free in the request's weeks. `freeHoursPerWeek` is the fewest free
 * hours in any of those weeks (what they can take on every week). Those who
 * cover the request come first, then by free hours, then by id.
 */
export function suggestMembers(
  load: Pick<CapacityLoad, 'weeks' | 'members'>,
  need: { skill: string; hoursPerWeek: number; startsOn: string; endsOn: string },
): MemberSuggestion[] {
  const out: MemberSuggestion[] = [];
  for (const member of load.members) {
    if (!hasSkill(member, need.skill)) continue;
    const free = freeHoursOver(member, load.weeks, need.startsOn, need.endsOn);
    if (free.length === 0) continue;
    const freeHoursPerWeek = Math.min(...free);
    out.push({
      memberId: member.memberId,
      skills: member.skills,
      weeklyHours: member.weeklyHours,
      freeHoursPerWeek,
      averageFreeHoursPerWeek: round2(free.reduce((sum, h) => sum + h, 0) / free.length),
      coversRequest: freeHoursPerWeek >= need.hoursPerWeek,
    });
  }
  return out.sort(
    (a, b) =>
      Number(b.coversRequest) - Number(a.coversRequest) ||
      b.freeHoursPerWeek - a.freeHoursPerWeek ||
      compareText(a.memberId, b.memberId),
  );
}

/**
 * Whether the team has the hours a request needs, per skill: the hours free
 * across everyone with the skill, in the load's weeks (`freeHoursPerWeek` is
 * the fewest in any week). A skill with no stated need is never short.
 */
export function skillFit(load: Pick<CapacityLoad, 'weeks' | 'members'>, needs: readonly NeededSkillInput[]): SkillFit[] {
  return needs.map((need) => {
    const people = load.members.filter((member) => hasSkill(member, need.skill));
    const free = load.weeks.map((_, i) =>
      round2(people.reduce((sum, member) => sum + Math.max(0, member.weeklyHours - member.cells[i].hours), 0)),
    );
    const needHours = need.hoursPerWeek ?? null;
    const shortWeeks = needHours === null ? 0 : free.filter((h) => h < needHours).length;
    return {
      skill: need.skill,
      needHoursPerWeek: needHours,
      freeHoursPerWeek: free.length > 0 ? Math.min(...free) : 0,
      shortWeeks,
      weeks: free.length,
      short: shortWeeks > 0,
    };
  });
}

// ── Roadmap line ────────────────────────────────────────────────────────────

/** `2026-11` or `2026-Q4` of a day. */
function bucketKey(days: number, quarter: boolean): string {
  const date = new Date(days * DAY_MS);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  return quarter ? `${year}-Q${Math.floor(month / 3) + 1}` : `${year}-${String(month + 1).padStart(2, '0')}`;
}

/**
 * The team load of a roadmap range, rolled up to months or quarters. A week
 * belongs to the month (or quarter) that holds its Thursday, as ISO weeks do;
 * weeks whose Thursday is outside `[from, to]` are left out. Every month (or
 * quarter) of the range is listed, in order.
 */
export function rollupLoad(
  load: Pick<CapacityLoad, 'weeks' | 'totals'>,
  from: string,
  to: string,
  quarter: boolean,
): RoadmapBucket[] {
  const fromDays = parseDate(from) ?? 0;
  const toDays = parseDate(to) ?? 0;
  const buckets = new Map<string, { startsOn: number; endsOn: number; booked: number; capacity: number }>();
  // Every period of the range, even one no week falls in.
  for (let day = fromDays; day <= toDays; ) {
    const date = new Date(day * DAY_MS);
    const month = quarter ? Math.floor(date.getUTCMonth() / 3) * 3 : date.getUTCMonth();
    const startsOn = Date.UTC(date.getUTCFullYear(), month, 1) / DAY_MS;
    const endsOn = Date.UTC(date.getUTCFullYear(), month + (quarter ? 3 : 1), 1) / DAY_MS - 1;
    buckets.set(bucketKey(day, quarter), { startsOn, endsOn, booked: 0, capacity: 0 });
    day = endsOn + 1;
  }
  load.weeks.forEach((week, i) => {
    const thursday = (parseDate(week.startsOn) ?? 0) + 3;
    if (thursday < fromDays || thursday > toDays) return;
    const bucket = buckets.get(bucketKey(thursday, quarter));
    if (!bucket) return;
    bucket.booked += load.totals[i].bookedHours;
    bucket.capacity += load.totals[i].capacityHours;
  });
  return [...buckets.entries()].map(([key, b]) => {
    const bookedHours = round2(b.booked);
    const capacityHours = round2(b.capacity);
    return {
      key,
      startsOn: formatDate(b.startsOn),
      endsOn: formatDate(b.endsOn),
      bookedHours,
      capacityHours,
      percent: capacityHours > 0 ? round2((bookedHours / capacityHours) * 100) : null,
    };
  });
}

// ── Wire shapes ─────────────────────────────────────────────────────────────

type BookingRow = typeof schema.resourceBookings.$inferSelect;
type RequestRow = typeof schema.resourceRequests.$inferSelect;
type ProfileRow = typeof schema.flowMemberProfiles.$inferSelect;

/** A booking as the routes answer it and the events carry it. */
export function presentBooking(row: BookingRow): ResourceBooking {
  return {
    id: row.id,
    memberId: row.memberId,
    projectId: row.projectId,
    requestId: row.requestId,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    hoursPerWeek: row.hoursPerWeek,
    tentative: row.tentative,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A resource request as the routes answer it; `projectName` is the name the caller may see. */
export function presentResourceRequest(row: RequestRow, projectName: string): ResourceRequest {
  return {
    id: row.id,
    projectId: row.projectId,
    projectName,
    skill: row.skill,
    hoursPerWeek: row.hoursPerWeek,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    status: row.status,
    bookingId: row.bookingId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The entity-event payload of a resource request (no project name: that depends on who asks). */
export function resourceRequestEventData(row: RequestRow): Record<string, unknown> {
  const data: Record<string, unknown> = { ...presentResourceRequest(row, '') };
  delete data.projectName;
  return data;
}

/** A member's profile; a member without a row gets the defaults. */
export function presentProfile(row: ProfileRow | null, memberId: string): MemberProfile {
  return {
    memberId,
    weeklyHours: row ? Number(row.weeklyHours) : DEFAULT_WEEKLY_HOURS,
    skills: row ? row.skills : [],
    hasProfile: row !== null,
    updatedAt: row ? row.updatedAt.toISOString() : null,
  };
}

/** Hours as the numeric column stores them: two decimals. */
export function hoursText(hours: number): string {
  return hours.toFixed(2);
}
