import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { HrPortalSettings } from '@weldsuite/db/schema';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';

/**
 * hr-api bindings: the kit's (auth, tenant DB, flags) plus only what
 * the hr module uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv {
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;

  // --- Workforce portal mails (services/weldhr/portal-mail.ts, @weldsuite/emails) -
  /** Cloudflare Email Service binding for outbound mail (portal invite
   *  and sign-in code emails). A missing/unconfigured transport is a no-op;
   *  see `workerTransport`. */
  SEND_EMAIL?: SendEmail;
  /** Migration switch: "resend" sends through Resend instead of Cloudflare.
   *  Flip to "cloudflare" (or unset) once mail.weldsuite.org is onboarded
   *  (docs/plans/system-email-cloudflare.md, Phase 0). */
  EMAIL_TRANSPORT?: string;
  /** Resend API key — the fallback transport while EMAIL_TRANSPORT="resend". */
  RESEND_API_KEY?: string;
  /** Migration-only sender override (noreply@weldsuite.org) until
   *  mail.weldsuite.org is onboarded; see `workerTransport`. */
  SYSTEM_EMAIL_FROM?: string;

  /**
   * Public origin of the WeldHR workforce portal (no trailing slash), used in
   * invite and sign-in emails when the workspace has no custom domain.
   * Defaults: production `https://team.weldsuite.org`, test
   * `https://team-test.weldsuite.org`, otherwise `http://localhost:3022`.
   */
  HR_PORTAL_URL?: string;
  /**
   * Public origin of the realtime worker (e.g. `wss://realtime.weldsuite.org`),
   * handed to the workforce portal with its connect ticket. Defaults per
   * ENVIRONMENT; set it for local runs on a non-default port.
   */
  REALTIME_PUBLIC_URL?: string;
}

export type Variables = KitVariables & {
  /** WeldHR workforce portal session (public `/public/hr-portal` only). */
  hrPortalAccessId?: string;
  hrPortalSettings?: HrPortalSettings;
  hrPortalKind?: 'employee' | 'client';
  hrPortalEmployeeId?: string | null;
  hrPortalCompanyId?: string | null;
  hrPortalEmail?: string;
  hrPortalSessionToken?: string;
};
