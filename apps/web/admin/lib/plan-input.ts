import { z } from 'zod';

/**
 * What a plan save may contain: the billing worker's rules
 * (`apps/workers/billing-worker/src/routes/admin.ts`, `planFields`), for the
 * Kubernetes editions, where the console writes `plans` itself (no Stripe).
 * Keep the two in step.
 */

const money = z
  .string()
  .trim()
  .regex(/^\d{1,9}(\.\d{1,2})?$/, 'Use an amount like 12 or 12.50');
const optionalInt = (min: number, max: number) => z.number().int().min(min).max(max).nullable();

export const planFields = {
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000).nullable(),
  priceMonthly: money,
  priceYearly: money,
  currency: z.string().trim().length(3).regex(/^[A-Za-z]{3}$/),
  pricePerUser: money.nullable(),
  includedUsers: optionalInt(0, 100_000),
  monthlyCredits: z.number().int().min(0).max(100_000_000),
  creditsRolloverCap: optionalInt(0, 1_000_000_000),
  maxUsers: optionalInt(0, 100_000),
  maxProjects: optionalInt(0, 1_000_000),
  maxCustomDomains: optionalInt(0, 100_000),
  removeBranding: z.boolean(),
  hasApiAccess: z.boolean(),
  isActive: z.boolean(),
  isDefault: z.boolean(),
  sortOrder: z.number().int().min(-10_000).max(10_000),
  badge: z.string().trim().max(50).nullable(),
  color: z.string().trim().max(20).nullable(),
  // PlanFeatures: flat flags/limits, plus the nested creditRates object.
  features: z.record(
    z.union([
      z.object({ aiTokens: z.number(), parcelLabel: z.number(), meetingBotMinute: z.number() }),
      z.string().max(500),
      z.number(),
      z.boolean(),
      z.null(),
    ]),
  ),
};

export const planCreateSchema = z.object({
  ...planFields,
  slug: z
    .string()
    .trim()
    .min(2)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, digits and dashes'),
});

/** The slug is fixed once created: code looks plans up by it (e.g. `free`). */
export const planUpdateSchema = z.object(planFields).partial();

/** The first problem zod found, as one line for a toast. */
export function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid plan.';
  return issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
}
