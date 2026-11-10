import { z } from 'zod';

/**
 * Response shapes of the live WeldDesk reports (desk-api):
 *
 * - GET /api/helpdesk-analytics/wallboard: the queue as it is right now;
 * - GET /api/helpdesk-analytics/phone: call KPIs for a period.
 *
 * Durations are whole seconds. Periods are whole UTC days, `start` inclusive
 * and `end` exclusive (ADR DESK-011).
 */

const pair = <T extends z.ZodTypeAny>(value: T) => z.object({ value, previous: value });

const seconds = z.number().nullable();

// ── Wallboard ───────────────────────────────────────────────────────────────

export const deskWallboardSchema = z.object({
  generatedAt: z.string(),
  queue: z.object({
    open: z.number(),
    unassigned: z.number(),
    waiting: z.number(),
    /** Seconds the longest-waiting open conversation has been waiting on the team. */
    oldestWaitingSeconds: seconds,
  }),
  sla: z.object({
    /** Open conversations whose SLA status is `breached`. */
    breached: z.number(),
    /** Open conversations whose SLA status is `warning`. */
    atRisk: z.number(),
    /** Open conversations with a running SLA clock, soonest due first, at most 8. */
    dueSoon: z.array(
      z.object({
        conversationId: z.string(),
        conversationNumber: z.number(),
        name: z.string().nullable(),
        dueAt: z.string(),
        metric: z.string().nullable(),
        status: z.enum(['active', 'warning', 'breached']),
        assigneeName: z.string().nullable(),
      }),
    ),
  }),
  /** The current UTC day. */
  today: z.object({
    created: z.number(),
    resolved: z.number(),
    firstResponseMedianSeconds: seconds,
  }),
  /** Active teams; conversations without a team are in no row. */
  teams: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      open: z.number(),
      unassigned: z.number(),
      waiting: z.number(),
      breached: z.number(),
    }),
  ),
  /** Active internal members, most open first, at most 50. */
  agents: z.array(z.object({ id: z.string(), name: z.string(), open: z.number(), away: z.boolean() })),
  /** Null when no phone route sends calls to agents (action `agents` or `menu`). */
  phone: z
    .object({
      waiting: z.number(),
      longestWaitSeconds: seconds,
      availableAgents: z.number(),
      answeredToday: z.number(),
      /** Outcome `missed` plus `voicemail`. */
      missedToday: z.number(),
      abandonedToday: z.number(),
    })
    .nullable(),
});

export type DeskWallboard = z.infer<typeof deskWallboardSchema>;

// ── Phone report ────────────────────────────────────────────────────────────

export const deskPhoneReportSchema = z.object({
  range: z.string(),
  /** UTC day, inclusive. */
  start: z.string(),
  /** UTC day, exclusive. */
  end: z.string(),
  /** The series' bucket: `day` up to 92 days, `week` up to 371, then `month`. */
  bucket: z.enum(['day', 'week', 'month']),
  kpis: z.object({
    offered: pair(z.number()),
    answered: pair(z.number()),
    missed: pair(z.number()),
    abandoned: pair(z.number()),
    voicemail: pair(z.number()),
    /** Percentage to one decimal; null when nothing was offered. */
    answerRate: pair(z.number().nullable()),
    waitAvg: pair(seconds),
    waitMedian: pair(seconds),
    abandonAvg: pair(seconds),
    handleAvg: pair(seconds),
    handleMedian: pair(seconds),
    longestWait: pair(seconds),
  }),
  series: z.array(
    z.object({
      /** YYYY-MM-DD, the first day of the bucket. */
      date: z.string(),
      offered: z.number(),
      answered: z.number(),
      missed: z.number(),
      abandoned: z.number(),
    }),
  ),
  agents: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      answered: z.number(),
      handleAvg: seconds,
      handleTotal: z.number(),
    }),
  ),
  teams: z.array(
    z.object({
      /** Null is the general queue. */
      id: z.string().nullable(),
      name: z.string().nullable(),
      offered: z.number(),
      answered: z.number(),
      missed: z.number(),
      abandoned: z.number(),
      waitAvg: seconds,
    }),
  ),
  /** All 24 UTC hours of the day the caller started waiting. */
  hours: z.array(z.object({ hour: z.number(), offered: z.number(), answered: z.number() })),
});

export type DeskPhoneReport = z.infer<typeof deskPhoneReportSchema>;
