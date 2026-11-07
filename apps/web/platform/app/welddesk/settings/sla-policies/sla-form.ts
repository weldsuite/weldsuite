/**
 * The SLA policy form: its values, the schema that checks them, and the
 * conversion to and from the `helpdesk_slas` columns (`DeskSlaPolicy`).
 *
 * Only what the engine reads is offered (`packages/core/db/src/lib/desk-sla.ts`):
 * the conditions it can evaluate, targets for low / medium / high / urgent,
 * one warning-before-breach time, and the calendar. Whatever the form does not
 * show (a `critical` target, `notifyAt` shares, after-breach reminders) is
 * carried over from the stored policy so an edit never drops it.
 */

import { z } from 'zod';
import type {
  CreateSlaInput,
  DeskSlaBusinessHours,
  DeskSlaCondition,
  DeskSlaPolicy,
  DeskSlaReminder,
  DeskSlaTarget,
} from '@/hooks/queries/use-desk-sla-queries';

export const SLA_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
export type SlaPriority = (typeof SLA_PRIORITIES)[number];

export const SLA_METRICS = ['firstResponseTime', 'updateTime', 'resolutionTime'] as const;
export type SlaMetricKey = (typeof SLA_METRICS)[number];

export const SLA_WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;
export type SlaWeekday = (typeof SLA_WEEKDAYS)[number];

/** The ticket fields the engine evaluates (`CONDITION_FIELDS`), by their canonical key. */
export const SLA_CONDITION_FIELDS = [
  'priority',
  'channel',
  'ticketTypeId',
  'departmentId',
  'tags',
  'assigneeId',
  'email',
] as const;
export type SlaConditionField = (typeof SLA_CONDITION_FIELDS)[number];

export type SlaOperator = 'equals' | 'not_equals' | 'contains' | 'greater_than' | 'less_than';

/** Operators that make sense per field; `greater_than` / `less_than` rank priorities. */
export const SLA_FIELD_OPERATORS: Record<SlaConditionField, SlaOperator[]> = {
  priority: ['equals', 'not_equals', 'greater_than', 'less_than'],
  channel: ['equals', 'not_equals'],
  ticketTypeId: ['equals', 'not_equals'],
  departmentId: ['equals', 'not_equals'],
  tags: ['contains', 'not_equals'],
  assigneeId: ['equals', 'not_equals'],
  email: ['equals', 'not_equals', 'contains'],
};

export const SLA_CHANNELS = ['messenger', 'email', 'phone', 'whatsapp', 'sms', 'api', 'portal'] as const;

/** The names the engine accepts for a field, mapped to the one the form uses. */
const FIELD_ALIASES: Record<string, SlaConditionField> = {
  priority: 'priority',
  channel: 'channel',
  ticketTypeId: 'ticketTypeId',
  ticketType: 'ticketTypeId',
  type: 'ticketTypeId',
  departmentId: 'departmentId',
  department: 'departmentId',
  teamId: 'departmentId',
  team: 'departmentId',
  tags: 'tags',
  tag: 'tags',
  assigneeId: 'assigneeId',
  assignee: 'assigneeId',
  email: 'email',
};

export function isConditionField(field: string): field is SlaConditionField {
  return (SLA_CONDITION_FIELDS as readonly string[]).includes(field);
}

export interface SlaConditionValues {
  /** A canonical field, or the stored name of one the engine cannot evaluate. */
  field: string;
  operator: SlaOperator;
  value: string;
}

export interface SlaTargetCell {
  hours: string;
  minutes: string;
}

export interface SlaDayValues {
  isOpen: boolean;
  openTime: string;
  closeTime: string;
}

export interface SlaHolidayValues {
  date: string;
  name: string;
  isRecurring: boolean;
}

export type SlaOperationalHoursValue = 'business' | '24x7' | 'custom';

export interface SlaFormValues {
  name: string;
  description: string;
  isActive: boolean;
  isDefault: boolean;
  priority: string;
  conditions: SlaConditionValues[];
  targets: Record<SlaMetricKey, Record<SlaPriority, SlaTargetCell>>;
  warnBefore: SlaTargetCell;
  operationalHours: SlaOperationalHoursValue;
  timezone: string;
  days: Record<SlaWeekday, SlaDayValues>;
  holidays: SlaHolidayValues[];
}

const MINUTES_PER_HOUR = 60;
/** Ten years in minutes: far above any sensible target, keeps the integer column safe. */
const MAX_MINUTES = 60 * 24 * 365 * 10;

const emptyCell = (): SlaTargetCell => ({ hours: '', minutes: '' });

function cellFromMinutes(minutes: number | undefined): SlaTargetCell {
  if (!minutes || minutes <= 0) return emptyCell();
  const whole = Math.round(minutes);
  const hours = Math.floor(whole / MINUTES_PER_HOUR);
  const rest = whole % MINUTES_PER_HOUR;
  return { hours: hours ? String(hours) : '', minutes: rest ? String(rest) : '' };
}

/** Minutes in a cell; 0 when it is empty. */
export function cellMinutes(cell: SlaTargetCell): number {
  return (Number(cell.hours) || 0) * MINUTES_PER_HOUR + (Number(cell.minutes) || 0);
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The IANA zones the browser knows, with `current` first when it is not among them. */
export function timezoneOptions(current: string): string[] {
  let zones: string[] = [];
  try {
    zones =
      (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    zones = [];
  }
  if (!zones.includes('UTC')) zones = ['UTC', ...zones];
  return current && !zones.includes(current) ? [current, ...zones] : zones;
}

const defaultDays = (): Record<SlaWeekday, SlaDayValues> =>
  Object.fromEntries(
    SLA_WEEKDAYS.map((day) => [
      day,
      { isOpen: day !== 'saturday' && day !== 'sunday', openTime: '09:00', closeTime: '17:00' },
    ]),
  ) as Record<SlaWeekday, SlaDayValues>;

function targetCells(list: DeskSlaTarget[]): Record<SlaPriority, SlaTargetCell> {
  const cells = {} as Record<SlaPriority, SlaTargetCell>;
  for (const priority of SLA_PRIORITIES) {
    cells[priority] = cellFromMinutes(list.find((t) => t.priority === priority)?.time);
  }
  return cells;
}

const beforeBreach = (reminders: DeskSlaReminder[]) =>
  reminders.filter((r) => r.type === 'before_breach' && r.time > 0);

export function newPolicyValues(nextPriority: number): SlaFormValues {
  return {
    name: '',
    description: '',
    isActive: true,
    isDefault: false,
    priority: String(nextPriority),
    conditions: [],
    targets: {
      firstResponseTime: targetCells([]),
      updateTime: targetCells([]),
      resolutionTime: targetCells([]),
    },
    warnBefore: emptyCell(),
    operationalHours: 'business',
    timezone: browserTimezone(),
    days: defaultDays(),
    holidays: [],
  };
}

export function policyToValues(policy: DeskSlaPolicy): SlaFormValues {
  const own = policy.businessHours;
  // The engine counts a 'business' policy that carries its own hours on those
  // hours, so that is a custom calendar as far as the form is concerned.
  const operationalHours: SlaOperationalHoursValue =
    policy.operationalHours === 'business' && own ? 'custom' : policy.operationalHours;
  const days = defaultDays();
  if (own) {
    for (const day of SLA_WEEKDAYS) {
      const stored = own[day];
      days[day] = stored
        ? { isOpen: stored.isOpen, openTime: stored.openTime || '09:00', closeTime: stored.closeTime || '17:00' }
        : { ...days[day], isOpen: false };
    }
  }
  const warnMinutes = Math.max(0, ...beforeBreach(policy.reminders).map((r) => r.time));
  return {
    name: policy.name,
    description: policy.description ?? '',
    isActive: policy.isActive,
    isDefault: policy.isDefault,
    priority: String(policy.priority),
    conditions: policy.conditions.map((c) => ({
      field: FIELD_ALIASES[c.field] ?? c.field,
      operator: c.operator,
      value: Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? ''),
    })),
    targets: {
      firstResponseTime: targetCells(policy.firstResponseTime),
      updateTime: targetCells(policy.updateTime),
      resolutionTime: targetCells(policy.resolutionTime),
    },
    warnBefore: cellFromMinutes(warnMinutes),
    operationalHours,
    timezone: own?.timezone || browserTimezone(),
    days,
    holidays: (own?.holidays ?? []).map((h) => ({ date: h.date, name: h.name, isRecurring: h.isRecurring === true })),
  };
}

/** Messages the form schema reports; the page fills them from the translations. */
export interface SlaFormMessages {
  nameRequired: string;
  nameTooLong: string;
  priorityInvalid: string;
  timeInvalid: string;
  conditionValueRequired: string;
  noTargets: string;
  timeTooLong: string;
  timezoneRequired: string;
  noOpenDay: string;
  closeBeforeOpen: string;
  holidayDateRequired: string;
}

/** The parts of the form the cross-field checks read. */
interface SlaTimesValues {
  targets: SlaFormValues['targets'];
  warnBefore: SlaFormValues['warnBefore'];
  timezone: string;
  days: Record<string, { isOpen: boolean; openTime: string; closeTime: string }>;
  holidays: Array<{ date: string }>;
}

export function createSlaFormSchema(m: SlaFormMessages) {
  const digits = z.string().regex(/^\d{0,7}$/, m.timeInvalid);
  const cell = z.object({ hours: digits, minutes: digits });
  const priorityCells = z.object({ urgent: cell, high: cell, medium: cell, low: cell });
  return z
    .object({
      name: z.string().trim().min(1, m.nameRequired).max(255, m.nameTooLong),
      description: z.string(),
      isActive: z.boolean(),
      isDefault: z.boolean(),
      priority: z.string().regex(/^\d{1,7}$/, m.priorityInvalid),
      conditions: z.array(
        z.object({
          field: z.string(),
          operator: z.enum(['equals', 'not_equals', 'contains', 'greater_than', 'less_than']),
          value: z.string().trim().min(1, m.conditionValueRequired),
        }),
      ),
      targets: z.object({
        firstResponseTime: priorityCells,
        updateTime: priorityCells,
        resolutionTime: priorityCells,
      }),
      warnBefore: cell,
      operationalHours: z.enum(['business', '24x7', 'custom']),
      timezone: z.string(),
      days: z.record(z.object({ isOpen: z.boolean(), openTime: z.string(), closeTime: z.string() })),
      holidays: z.array(z.object({ date: z.string(), name: z.string(), isRecurring: z.boolean() })),
    })
    .superRefine((values, ctx) => {
      checkTargets(values, ctx);
      if (values.operationalHours === 'custom') checkCustomHours(values, ctx);
    });

  /** At least one target, none longer than the maximum (and the warning too). */
  function checkTargets(values: SlaTimesValues, ctx: z.RefinementCtx) {
    let anyTarget = false;
    for (const metric of SLA_METRICS) {
      for (const priority of SLA_PRIORITIES) {
        const minutes = cellMinutes(values.targets[metric][priority]);
        if (minutes > 0) anyTarget = true;
        if (minutes > MAX_MINUTES) {
          ctx.addIssue({ code: 'custom', message: m.timeTooLong, path: ['targets', metric, priority, 'hours'] });
        }
      }
    }
    if (!anyTarget) ctx.addIssue({ code: 'custom', message: m.noTargets, path: ['targets'] });
    if (cellMinutes(values.warnBefore) > MAX_MINUTES) {
      ctx.addIssue({ code: 'custom', message: m.timeTooLong, path: ['warnBefore', 'hours'] });
    }
  }

  /** The policy's own hours: a timezone, an open day, and holidays with a date. */
  function checkCustomHours(values: SlaTimesValues, ctx: z.RefinementCtx) {
    if (!values.timezone.trim()) ctx.addIssue({ code: 'custom', message: m.timezoneRequired, path: ['timezone'] });
    const open = SLA_WEEKDAYS.filter((day) => values.days[day]?.isOpen);
    if (open.length === 0) ctx.addIssue({ code: 'custom', message: m.noOpenDay, path: ['days'] });
    for (const day of open) {
      const { openTime, closeTime } = values.days[day];
      if (!openTime || !closeTime || openTime >= closeTime) {
        ctx.addIssue({ code: 'custom', message: m.closeBeforeOpen, path: ['days', day, 'closeTime'] });
      }
    }
    values.holidays.forEach((holiday, index) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(holiday.date)) {
        ctx.addIssue({ code: 'custom', message: m.holidayDateRequired, path: ['holidays', index, 'date'] });
      }
    });
  }
}

/** A metric's targets as stored: this form's priorities from the cells, the rest as they were. */
function targetsPayload(cells: Record<SlaPriority, SlaTargetCell>, stored: DeskSlaTarget[]): DeskSlaTarget[] {
  const kept = stored.filter((t) => !(SLA_PRIORITIES as readonly string[]).includes(t.priority));
  const edited: DeskSlaTarget[] = [];
  for (const priority of SLA_PRIORITIES) {
    const time = cellMinutes(cells[priority]);
    if (time <= 0) continue;
    const before = stored.find((t) => t.priority === priority);
    // Shares of the target to warn at survive an edit of the time.
    edited.push({ ...(before?.notifyAt ? { notifyAt: before.notifyAt } : {}), priority, time });
  }
  return [...edited, ...kept];
}

function conditionPayload(c: SlaConditionValues): DeskSlaCondition {
  return { field: c.field, operator: c.operator, value: c.value.trim() };
}

function remindersPayload(warn: SlaTargetCell, stored: DeskSlaReminder[]): DeskSlaReminder[] {
  const others = stored.filter((r) => r.type !== 'before_breach');
  const time = cellMinutes(warn);
  if (time <= 0) return others;
  const recipients = beforeBreach(stored)[0]?.recipients ?? ['assignee'];
  return [{ type: 'before_breach', time, recipients }, ...others];
}

function hoursPayload(values: SlaFormValues): DeskSlaBusinessHours {
  const hours: DeskSlaBusinessHours = { timezone: values.timezone.trim() };
  for (const day of SLA_WEEKDAYS) {
    const v = values.days[day];
    hours[day] = v.isOpen ? { isOpen: true, openTime: v.openTime, closeTime: v.closeTime } : { isOpen: false };
  }
  hours.holidays = values.holidays.map((h) => ({
    date: h.date,
    name: h.name.trim(),
    isRecurring: h.isRecurring,
  }));
  return hours;
}

/** The body for POST / PATCH `/api/slas`. `stored` is the policy being edited, if any. */
export function valuesToPayload(values: SlaFormValues, stored: DeskSlaPolicy | null): CreateSlaInput {
  const custom = values.operationalHours === 'custom';
  return {
    name: values.name.trim(),
    description: values.description.trim() || null,
    isActive: values.isActive,
    isDefault: values.isDefault,
    priority: Number(values.priority),
    // The default policy is the fallback: it has no conditions of its own.
    conditions: values.isDefault ? [] : values.conditions.map(conditionPayload),
    firstResponseTime: targetsPayload(values.targets.firstResponseTime, stored?.firstResponseTime ?? []),
    updateTime: targetsPayload(values.targets.updateTime, stored?.updateTime ?? []),
    resolutionTime: targetsPayload(values.targets.resolutionTime, stored?.resolutionTime ?? []),
    reminders: remindersPayload(values.warnBefore, stored?.reminders ?? []),
    operationalHours: values.operationalHours,
    businessHours: custom ? hoursPayload(values) : null,
  };
}
