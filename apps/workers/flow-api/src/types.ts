import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';

/**
 * flow-api bindings: the kit's (auth, tenant DB, flags) plus only what
 * the flow module uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv {
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out (also the
   *  in-app channel of @weldsuite/notifications). */
  REALTIME?: Fetcher;

  /** R2 bucket for project files, documents, sheets, task attachments and
   *  task-import payloads. */
  STORAGE?: R2Bucket;
  /** Public hostname that serves objects in the STORAGE bucket. */
  R2_PUBLIC_URL?: string;

  // --- Project analytics (R2 SQL / Iceberg, @weldsuite/core-domain) ---------
  /** Bearer token for the Cloudflare R2 SQL REST API. */
  R2_SQL_API_TOKEN?: string;
  /** Name of the R2 bucket that holds the Iceberg analytics catalog. */
  R2_ANALYTICS_BUCKET?: string;
  CF_ACCOUNT_ID?: string;

  /** CF Workflow that sends one user's daily task digest email. Hosted in
   *  this worker (class re-exported from src/index.ts, @weldsuite/flow-domain)
   *  under the `send-digest-v3*` names — app-api's old `send-digest-v2*`
   *  names keep draining (docs/plans/app-api-module-split.md). Dispatched by
   *  the hourly digest sweep cron (src/cron/digest-sweep.ts). */
  SEND_DIGEST?: Workflow<{
    workspaceId: string;
    userId: string;
    email: string;
    name: string;
    timezone: string;
  }>;
  /** CF Workflow that bulk-imports project tasks from an R2 JSON payload.
   *  Hosted in this worker (class re-exported from src/index.ts,
   *  @weldsuite/flow-domain) under the `import-tasks-v3*` names — app-api's
   *  old `import-tasks-v2*` names keep draining. Dispatched by
   *  POST /api/projects/:projectId/tasks/import-jobs. */
  IMPORT_TASKS?: Workflow<{
    jobId: string;
    workspaceId: string;
    userId: string;
    projectId: string;
    r2Key: string;
  }>;
  /** Cloudflare `[[send_email]]` binding — the SendDigest fallback when
   *  RESEND_API_KEY is unset. */
  SEND_EMAIL?: SendEmail;

  /** CF Workflow that pushes a task mutation to its linked GitHub Project item
   *  (Projects-v2 outbound). Class hosted in integration-webhook-worker; bound
   *  here via `script_name` in test/production. */
  GITHUB_PROJECT_OUTBOUND?: Workflow;

  // --- Notifications (`@weldsuite/notifications`, task assignment) ---------
  // In-app delivery uses the REALTIME service binding declared above.
  /** Resend API key — used by the email channel and the task digest workflow.
   *  Optional locally. */
  RESEND_API_KEY?: string;
  /** Resend template id for the task-assignment email. When unset, the
   *  helper falls back to a plain-text email. */
  RESEND_TEMPLATE_TASK_ASSIGNED?: string;
  /** Absolute base URL for links in notification emails / push payloads,
   *  e.g. `https://app.weldsuite.org`. */
  PUBLIC_APP_URL?: string;
  /** CF Workflow that holds a notification email until the recipient has been
   *  away for the defer window. Hosted in app-api (`deferred-notification-email*`
   *  names), bound here cross-script via `script_name` in test/production. */
  DEFERRED_NOTIFICATION_EMAIL?: Workflow<{
    workspaceId: string;
    userId: string;
    notificationId: string;
    to: string;
    subject: string;
    fallbackText: string;
    sendAfter: string;
    template?: { id: string; variables: Record<string, string | number | boolean> };
  }>;
}

export type Variables = KitVariables;
