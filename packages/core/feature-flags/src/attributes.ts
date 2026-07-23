/**
 * Attribute shape used everywhere we evaluate a flag — frontend SPA,
 * Next.js apps, Expo, Workers. Keeping a single source of truth lets
 * Flagship targeting rules be expressed once and apply uniformly.
 */

export type AppSurface =
  | 'platform'
  | 'sites'
  | 'helpcenter'
  | 'booking-portal'
  | 'meeting-portal'
  | 'parcel-tracking-portal'
  | 'parcel-return-portal'
  | 'mobile'
  | 'app-api'
  | 'agent-worker'
  | 'external-api';

export type Plan = 'free' | 'business' | 'scale' | 'unknown';

export type Environment = 'development' | 'test' | 'preview' | 'production';

export interface FlagAttributes {
  userId: string;
  workspaceId: string;
  plan: Plan;
  role: string;
  environment: Environment;
  app: AppSurface;
  /** Locale (en / nl) — useful for copy-experiment targeting. */
  locale?: string;
}

export function buildAttributes(input: FlagAttributes): FlagAttributes {
  // Identity helper. Exists so call sites have one named entry point in
  // case we want to enrich attributes later (e.g. derive a hashed
  // workspaceBucket for sticky rollouts).
  return input;
}
