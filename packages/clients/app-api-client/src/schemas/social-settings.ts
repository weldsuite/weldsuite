import { z } from 'zod';

export const updateSocialSettingsSchema = z.object({
  defaultTimezone: z.string().optional(),
  defaultApprovalRequired: z.boolean().optional(),
  autoScheduleEnabled: z.boolean().optional(),
  bestTimeToPost: z
    .object({
      enabled: z.boolean(),
      times: z.array(z.object({ day: z.number(), hour: z.number() })),
    })
    .optional(),
  hashtagSuggestions: z.boolean().optional(),
  linkShortening: z.boolean().optional(),
  utmTracking: z
    .object({
      enabled: z.boolean(),
      source: z.string(),
      medium: z.string(),
      campaign: z.string(),
    })
    .optional(),
  notifications: z
    .object({
      publishedPosts: z.boolean(),
      failedPosts: z.boolean(),
      approvalRequests: z.boolean(),
      weeklyReport: z.boolean(),
    })
    .optional(),
});

export type UpdateSocialSettingsInput = z.infer<typeof updateSocialSettingsSchema>;
