import { z } from 'zod';

export const deskWidgetBrandingSchema = z.object({
  primaryColor: z.string().max(30).optional(),
  backgroundColor: z.string().max(30).optional(),
  position: z.enum(['right', 'left']).optional(),
});

export const DESK_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export const DESK_EXPECTED_REPLY_TIMES = ['few_minutes', 'hour', 'few_hours', 'day'] as const;

const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');

/** One opening window per weekday; `end` may be 24:00 and must come after `start`. */
export const deskOfficeHoursWindowSchema = z
  .object({
    start: clockTime,
    end: z.union([clockTime, z.literal('24:00')]),
  })
  .refine((window) => window.end > window.start, {
    message: 'End time must be after start time',
    path: ['end'],
  });

/** A missing or null weekday is closed all day. */
const officeHoursDay = deskOfficeHoursWindowSchema.nullable().optional();

export const deskOfficeHoursSchema = z.object({
  enabled: z.boolean(),
  days: z
    .object({
      mon: officeHoursDay,
      tue: officeHoursDay,
      wed: officeHoursDay,
      thu: officeHoursDay,
      fri: officeHoursDay,
      sat: officeHoursDay,
      sun: officeHoursDay,
    })
    .strict(),
});

/** An IANA zone the runtime knows, e.g. Europe/Amsterdam. */
export const deskTimeZoneSchema = z
  .string()
  .max(64)
  .refine(
    (zone) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Unknown timezone' },
  );

export const createDeskWidgetSchema = z.object({
  widgetName: z.string().max(255).optional(),
  greeting: z.string().max(500).optional(),
  branding: deskWidgetBrandingSchema.optional(),
  allowedDomains: z.array(z.string().max(255)).optional(),
});

export const updateDeskWidgetSchema = z.object({
  widgetName: z.string().max(255).optional(),
  enabled: z.boolean().optional(),
  greeting: z.string().max(500).nullish(),
  branding: deskWidgetBrandingSchema.optional(),
  allowedDomains: z.array(z.string().max(255)).optional(),
  officeHours: deskOfficeHoursSchema.nullish(),
  timezone: deskTimeZoneSchema.nullish(),
  awayMessage: z.string().trim().max(1000).nullish(),
  expectedReplyTime: z.enum(DESK_EXPECTED_REPLY_TIMES).nullish(),
});

export type CreateDeskWidgetInput = z.infer<typeof createDeskWidgetSchema>;
export type UpdateDeskWidgetInput = z.infer<typeof updateDeskWidgetSchema>;
export type DeskOfficeHoursInput = z.infer<typeof deskOfficeHoursSchema>;
