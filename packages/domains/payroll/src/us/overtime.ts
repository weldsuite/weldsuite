/**
 * Overtime per FLSA workweek, with California's daily rules, and the
 * qualified overtime compensation for W-2 box 12 code TT.
 *
 * Rules applied:
 * - FLSA (29 USC 207(a)): hours over 40 in a workweek at 1.5 × the regular
 *   rate. A workweek is a fixed, recurring 168-hour period starting on the
 *   employer's `workweekStartDay`; each workweek stands alone (IRS
 *   FS-2026-13 Q13, https://www.irs.gov/pub/taxpros/fs-2026-13.pdf).
 * - Regular rate = straight-time pay for the week ÷ hours worked (FS-2026-13
 *   Q15). Simplification: bonuses and commissions are not folded into the
 *   regular rate, so a nondiscretionary bonus does not trigger an overtime
 *   true-up of earlier workweeks; the employer has to add that true-up as a
 *   manual line. Paid leave hours are not hours worked.
 * - California (DIR overtime FAQ, https://www.dir.ca.gov/dlse/faq_overtime.htm):
 *   1.5× for hours over 8 in a day and over 40 regular hours in the week;
 *   2× over 12 in a day; on the seventh consecutive day of work in the
 *   workweek 1.5× for the first 8 hours and 2× after that.
 * - Qualified overtime (code TT) is only the FLSA-required half-time premium:
 *   hours over 40 × ½ × regular rate (FS-2026-13 Q12). California daily
 *   overtime and the double-time part beyond 1.5× are not qualified (Q16).
 *
 * Hourly employees are paid straight time for every hour through their
 * regular-hours lines, so this module adds only premiums (0.5× / 1.0× of the
 * regular rate). For salaried non-exempt employees the salary is taken to
 * cover the non-overtime hours of the week (California Labor Code 515(d):
 * regular rate = weekly salary ÷ 40), so overtime hours are paid in full
 * (1.5× / 2×). Simplification: hours between a shorter contract week and 40
 * earn nothing extra.
 *
 * Manual overtime lines (`hours.overtime`, rate = multiplier percent) with a
 * work date count as hours worked in their workweek, and what they pay above
 * straight time is credited against the premium due (29 USC 207(h)).
 *
 * Workweeks that straddle two pay periods are settled in the period that
 * contains the workweek's last day. The earlier days are paid at straight
 * time in their own period and carried (see `US_OT_CARRY_PREFIX` in ytd.ts).
 * This pays FLSA overtime on the regular payday for the period in which the
 * workweek ends (29 CFR 778.106) and California overtime by the next regular
 * payday (Labor Code 204(b)(1)).
 */

import { addDays, weekday } from '../periods';
import { roundHalfAwayFromZero, type Cents } from '../money';
import { US_OT_CARRY_PREFIX } from './ytd';

export interface HoursEntry {
  /** `YYYY-MM-DD`. */
  date: string;
  hours: number;
  /** Straight-time hourly rate in cents (may be fractional). */
  rateCents: number;
  /** Manual overtime: the multiplier (1.5 for 150%). Null for regular hours. */
  multiplier: number | null;
}

export interface OvertimeInput {
  entries: HoursEntry[];
  periodStart: string;
  periodEnd: string;
  /** 0 = Sunday … 6 = Saturday. */
  workweekStartDay: number;
  california: boolean;
  /** Salaried non-exempt: the regular rate the salary implies (cents per hour). Null = hourly. */
  salariedRegularRateCents: number | null;
  /** Accumulators from earlier payslips (read for `us.ot_carry.*`). */
  ytd: Record<string, Cents>;
}

export interface WorkweekResult {
  weekStart: string;
  weekEnd: string;
  hours: number;
  regularRateCents: number;
  /** Hours over 40 (FLSA). */
  flsaOvertimeHours: number;
  /** Hours paid at 1.5× (FLSA, or California daily/weekly/seventh-day). */
  overtimeHours: number;
  /** Hours paid at 2× (California). */
  doubleTimeHours: number;
  /** Pay the rules require on top of what straight-time lines pay (hourly: premiums; salaried: full overtime pay). */
  requiredCents: number;
  /** Already paid through manual overtime lines and credited. */
  creditedCents: number;
  /** FLSA half-time premium for code TT, cents. */
  qualifiedOvertimeCents: Cents;
}

export interface OvertimeLine {
  kind: 'overtime_premium' | 'double_time_premium' | 'overtime' | 'double_time';
  hours: number | null;
  /** Per hour, currency units (for display). */
  rate: number | null;
  amountCents: Cents;
}

export interface OvertimeResult {
  weeks: WorkweekResult[];
  lines: OvertimeLine[];
  qualifiedOvertimeCents: Cents;
  /** Carry keys to set in the result's YTD (weeks that end after the period). */
  carryOut: Record<string, Cents>;
  /** Carry keys settled this period: remove them from the result's YTD. */
  settledCarryKeys: string[];
}

/** First day of the workweek containing `date`. */
export function workweekStart(date: string, workweekStartDay: number): string {
  const offset = (weekday(date) - workweekStartDay + 7) % 7;
  return addDays(date, -offset);
}

interface WeekBucket {
  weekStart: string;
  dayHours: number[];
  straightPayCents: number;
  manualPremiumCents: number;
  manualFullCents: number;
  carryKeys: string[];
}

function emptyBucket(weekStart: string): WeekBucket {
  return { weekStart, dayHours: [0, 0, 0, 0, 0, 0, 0], straightPayCents: 0, manualPremiumCents: 0, manualFullCents: 0, carryKeys: [] };
}

function carryKey(weekStart: string, field: string): string {
  return `${US_OT_CARRY_PREFIX}${weekStart}.${field}`;
}

const DAY_FIELDS = ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6'];

/** California split of one workweek's days into regular, 1.5× and 2× hours. */
export function californiaSplit(dayHours: readonly number[]): { regular: number; overtime: number; doubleTime: number } {
  const seventhDay = dayHours.every((h) => h > 0);
  let regular = 0;
  let overtime = 0;
  let doubleTime = 0;
  dayHours.forEach((h, i) => {
    if (h <= 0) return;
    if (seventhDay && i === 6) {
      overtime += Math.min(h, 8);
      doubleTime += Math.max(0, h - 8);
      return;
    }
    regular += Math.min(h, 8);
    overtime += Math.min(Math.max(h - 8, 0), 4);
    doubleTime += Math.max(0, h - 12);
  });
  if (regular > 40) {
    overtime += regular - 40;
    regular = 40;
  }
  return { regular, overtime, doubleTime };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeOvertime(input: OvertimeInput): OvertimeResult {
  const buckets = new Map<string, WeekBucket>();
  const bucket = (weekStart: string): WeekBucket => {
    let b = buckets.get(weekStart);
    if (!b) {
      b = emptyBucket(weekStart);
      buckets.set(weekStart, b);
    }
    return b;
  };

  // Hours carried from earlier periods.
  for (const [key, value] of Object.entries(input.ytd)) {
    if (!key.startsWith(US_OT_CARRY_PREFIX)) continue;
    const rest = key.slice(US_OT_CARRY_PREFIX.length);
    const dot = rest.lastIndexOf('.');
    if (dot < 0) continue;
    const weekStart = rest.slice(0, dot);
    const field = rest.slice(dot + 1);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) continue;
    const b = bucket(weekStart);
    b.carryKeys.push(key);
    const dayIndex = DAY_FIELDS.indexOf(field);
    if (dayIndex >= 0) b.dayHours[dayIndex] += value / 100;
    else if (field === 'pay') b.straightPayCents += value;
    else if (field === 'premium') {
      // Holds the premium part (hourly) or the full manual pay (salaried); only one is read below.
      b.manualPremiumCents += value;
      b.manualFullCents += value;
    }
  }

  // This period's dated hours.
  for (const e of input.entries) {
    if (!(e.hours > 0)) continue;
    const weekStart = workweekStart(e.date, input.workweekStartDay);
    const b = bucket(weekStart);
    const day = (weekday(e.date) - input.workweekStartDay + 7) % 7;
    b.dayHours[day] += e.hours;
    b.straightPayCents += e.hours * e.rateCents;
    if (e.multiplier !== null) {
      b.manualPremiumCents += e.hours * e.rateCents * Math.max(0, e.multiplier - 1);
      b.manualFullCents += e.hours * e.rateCents * e.multiplier;
    }
  }

  const salaried = input.salariedRegularRateCents !== null;
  const weeks: WorkweekResult[] = [];
  const lines: OvertimeLine[] = [];
  const carryOut: Record<string, Cents> = {};
  const settledCarryKeys: string[] = [];
  let qualified = 0;

  const sorted = [...buckets.values()].sort((a, b) => (a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0));
  for (const b of sorted) {
    const weekEnd = addDays(b.weekStart, 6);
    if (weekEnd > input.periodEnd) {
      // Not settled yet: carry everything (earlier carry included) to the next period.
      b.dayHours.forEach((h, i) => {
        if (h > 0) carryOut[carryKey(b.weekStart, DAY_FIELDS[i])] = Math.round(h * 100);
      });
      if (!salaried && b.straightPayCents > 0) carryOut[carryKey(b.weekStart, 'pay')] = roundHalfAwayFromZero(b.straightPayCents);
      const credit = salaried ? b.manualFullCents : b.manualPremiumCents;
      if (credit > 0) carryOut[carryKey(b.weekStart, 'premium')] = roundHalfAwayFromZero(credit);
      settledCarryKeys.push(...b.carryKeys.filter((k) => !(k in carryOut)));
      continue;
    }
    settledCarryKeys.push(...b.carryKeys);

    const hours = round2(b.dayHours.reduce((s, h) => s + h, 0));
    if (hours <= 0) continue;
    const regularRate = salaried ? (input.salariedRegularRateCents as number) : b.straightPayCents / hours;
    const flsaOvertimeHours = round2(Math.max(0, hours - 40));
    let overtimeHours = flsaOvertimeHours;
    let doubleTimeHours = 0;
    if (input.california) {
      const split = californiaSplit(b.dayHours);
      overtimeHours = round2(split.overtime);
      doubleTimeHours = round2(split.doubleTime);
    }
    const otFactor = salaried ? 1.5 : 0.5;
    const dtFactor = salaried ? 2 : 1;
    const otCents = overtimeHours * otFactor * regularRate;
    const dtCents = doubleTimeHours * dtFactor * regularRate;
    const required = otCents + dtCents;
    const credited = salaried ? b.manualFullCents : b.manualPremiumCents;
    const qualifiedCents = roundHalfAwayFromZero(flsaOvertimeHours * 0.5 * regularRate);
    qualified += qualifiedCents;
    weeks.push({
      weekStart: b.weekStart,
      weekEnd,
      hours,
      regularRateCents: regularRate,
      flsaOvertimeHours,
      overtimeHours,
      doubleTimeHours,
      requiredCents: required,
      creditedCents: credited,
      qualifiedOvertimeCents: qualifiedCents,
    });

    if (credited <= 0) {
      if (overtimeHours > 0) {
        lines.push({
          kind: salaried ? 'overtime' : 'overtime_premium',
          hours: overtimeHours,
          rate: (otFactor * regularRate) / 100,
          amountCents: roundHalfAwayFromZero(otCents),
        });
      }
      if (doubleTimeHours > 0) {
        lines.push({
          kind: salaried ? 'double_time' : 'double_time_premium',
          hours: doubleTimeHours,
          rate: (dtFactor * regularRate) / 100,
          amountCents: roundHalfAwayFromZero(dtCents),
        });
      }
    } else {
      const due = roundHalfAwayFromZero(Math.max(0, required - credited));
      if (due > 0) lines.push({ kind: salaried ? 'overtime' : 'overtime_premium', hours: null, rate: null, amountCents: due });
    }
  }

  return { weeks, lines, qualifiedOvertimeCents: qualified, carryOut, settledCarryKeys };
}
