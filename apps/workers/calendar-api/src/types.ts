import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';

/**
 * calendar-api bindings: the kit's (auth, tenant DB, flags) plus only what
 * the calendar module uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv {
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;

  // --- Calendar attendee mails (services/calendar-mail.ts) -------------------
  /** Resend API key. Calendar attendee mails no-op entirely when it is unset. */
  RESEND_API_KEY?: string;
  /** Resend template ids for the calendar attendee emails (invite /
   *  reschedule / cancel), read by services/calendar-mail.ts. Each is
   *  independently optional: when one is unset that mail falls back to the
   *  inline HTML template, matching the legacy api-worker behaviour. Mail
   *  no-ops entirely when RESEND_API_KEY is unset. */
  RESEND_MEETING_INVITE_TEMPLATE_ID?: string;
  RESEND_MEETING_UPDATE_TEMPLATE_ID?: string;
  RESEND_MEETING_CANCEL_TEMPLATE_ID?: string;

  // --- Google Calendar outbound sync (lib/integrations) ----------------------
  /** Google Calendar OAuth app credentials (distinct from GOOGLE_CLIENT_ID,
   *  which belongs to the WeldConnect workflow-integrations app). Used to
   *  refresh access tokens when pushing events to Google. */
  GOOGLE_CALENDAR_CLIENT_ID?: string;
  GOOGLE_CALENDAR_CLIENT_SECRET?: string;
}

export type Variables = KitVariables;
