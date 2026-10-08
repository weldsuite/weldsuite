import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';

/**
 * calendar-api bindings: the kit's (auth, tenant DB, flags) plus only what
 * the calendar module uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv {
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** Schedule-index D1: `workspace_due_index` rows (kind `calendar_replan`)
   *  telling the nightly re-plan which workspaces have an event due. */
  SCHEDULE_INDEX?: D1Database;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;

  // --- Calendar attendee mails (services/calendar-mail.ts, @weldsuite/emails) -
  /** Cloudflare Email Service binding. Calendar attendee mails no-op entirely
   *  when neither this nor RESEND_API_KEY is set (see `workerTransport`). */
  SEND_EMAIL?: SendEmail;
  /** Migration switch: "resend" sends through Resend instead of Cloudflare.
   *  Flip to "cloudflare" (or unset) once mail.weldsuite.org is onboarded
   *  (docs/plans/system-email-cloudflare.md, Phase 0). */
  EMAIL_TRANSPORT?: string;
  /** Resend API key — the fallback transport while EMAIL_TRANSPORT="resend". */
  RESEND_API_KEY?: string;
  /** Migration-only sender override; see `workerTransport`. */
  SYSTEM_EMAIL_FROM?: string;

  // --- Google Calendar outbound sync (lib/integrations) ----------------------
  /** Google Calendar OAuth app credentials (distinct from GOOGLE_CLIENT_ID,
   *  which belongs to the WeldConnect workflow-integrations app). Used to
   *  refresh access tokens when pushing events to Google. */
  GOOGLE_CALENDAR_CLIENT_ID?: string;
  GOOGLE_CALENDAR_CLIENT_SECRET?: string;
}

export type Variables = KitVariables;
