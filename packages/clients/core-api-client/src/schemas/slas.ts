import { z } from 'zod';

// `/api/slas` — backed by `helpdesk_slas`. SLA policies that drive ticket
// response/resolution deadlines (engine: `@weldsuite/db/lib/desk-sla`, ADR
// DESK-009). The shape mirrors the table's columns; the Rust twin is
// `sla_schema` in `rust/modules/desk/src/simple.rs`, keep them in step.

/** Ticket priorities a target can be set for (`TicketPriority` in the schema). */
export const SLA_TARGET_PRIORITIES = ['low', 'medium', 'high', 'urgent', 'critical'] as const;
export const SLA_CONDITION_OPERATORS = ['equals', 'not_equals', 'contains', 'greater_than', 'less_than'] as const;
export const SLA_OPERATIONAL_HOURS = ['business', '24x7', 'custom'] as const;
export const SLA_REMINDER_TYPES = ['before_breach', 'after_breach'] as const;
export const SLA_REMINDER_RECIPIENTS = ['assignee', 'manager', 'customer'] as const;
export const SLA_WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

export const slaConditionSchema = z
  .object({
    field: z.string().min(1).max(100),
    operator: z.enum(SLA_CONDITION_OPERATORS),
    value: z.unknown(),
  })
  .passthrough();

/** One target: `time` is minutes; `notifyAt` are percentages of the target. */
export const slaTargetSchema = z
  .object({
    priority: z.enum(SLA_TARGET_PRIORITIES),
    time: z.number().int().min(1),
    notifyAt: z.array(z.number().min(0).max(100)).optional(),
  })
  .passthrough();

export const slaReminderSchema = z
  .object({
    type: z.enum(SLA_REMINDER_TYPES),
    time: z.number().int().min(1),
    recipients: z.array(z.enum(SLA_REMINDER_RECIPIENTS)).optional(),
  })
  .passthrough();

const slaWorkDaySchema = z
  .object({
    isOpen: z.boolean(),
    openTime: z.string().max(10).optional(),
    closeTime: z.string().max(10).optional(),
  })
  .passthrough();

export const slaBusinessHoursSchema = z
  .object({
    timezone: z.string().min(1).max(100),
    monday: slaWorkDaySchema.optional(),
    tuesday: slaWorkDaySchema.optional(),
    wednesday: slaWorkDaySchema.optional(),
    thursday: slaWorkDaySchema.optional(),
    friday: slaWorkDaySchema.optional(),
    saturday: slaWorkDaySchema.optional(),
    sunday: slaWorkDaySchema.optional(),
    holidays: z
      .array(
        z
          .object({
            date: z.string().min(1).max(10),
            name: z.string().max(255),
            isRecurring: z.boolean().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export const createSlaSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().nullish(),
  /** Order the policies are checked in: lowest first. */
  priority: z.number().int().min(0).max(1_000_000).optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  conditions: z.array(slaConditionSchema).nullish(),
  firstResponseTime: z.array(slaTargetSchema).nullish(),
  updateTime: z.array(slaTargetSchema).nullish(),
  resolutionTime: z.array(slaTargetSchema).nullish(),
  reminders: z.array(slaReminderSchema).nullish(),
  operationalHours: z.enum(SLA_OPERATIONAL_HOURS).optional(),
  businessHours: slaBusinessHoursSchema.nullish(),
}).passthrough();

export const updateSlaSchema = createSlaSchema.partial();

export type CreateSlaInput = z.infer<typeof createSlaSchema>;
export type UpdateSlaInput = z.infer<typeof updateSlaSchema>;
export type SlaCondition = z.infer<typeof slaConditionSchema>;
export type SlaTarget = z.infer<typeof slaTargetSchema>;
export type SlaReminder = z.infer<typeof slaReminderSchema>;
export type SlaBusinessHours = z.infer<typeof slaBusinessHoursSchema>;

/** A `helpdesk_slas` row, as /api/slas returns it. */
export const slaSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    conditions: z.unknown(),
    isDefault: z.boolean().nullable(),
    firstResponseTime: z.unknown(),
    resolutionTime: z.unknown(),
    updateTime: z.unknown(),
    operationalHours: z.string(),
    businessHours: z.unknown(),
    escalationRules: z.unknown(),
    isActive: z.boolean(),
    priority: z.number().nullable(),
    reminders: z.unknown(),
  })
  .passthrough();

export type Sla = z.infer<typeof slaSchema>;
