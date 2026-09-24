/**
 * WeldConnect MVP scope — the triggers and actions the WeldConnect editor
 * offers. The engine supports more (shared with WeldDesk workflows and CRM
 * sequences), but WeldConnect only exposes what's production-ready.
 *
 * Keep in sync with the server-side activation gate in
 * apps/workers/app-api/src/services/weldconnect-mvp.ts, which rejects
 * activating a workflow that uses anything else.
 */

import { isApiError } from '@weldsuite/api-client';

export const WELDCONNECT_TRIGGER_TYPES = ['entity_event', 'schedule'] as const;

/** Only recurring schedules are supported (the cron sweep has no one-off runs). */
export const WELDCONNECT_SCHEDULE_TYPES = ['recurring'] as const;

export const WELDCONNECT_ACTION_TYPES = ['send_email', 'create_customer'] as const;

/** CRM sequences are `workflows` rows too; WeldConnect lists exclude them. */
export const SEQUENCE_WORKFLOW_TAG = '__type:sequence';

/** True when app-api refused to activate a workflow because it's outside the MVP scope. */
export function isUnsupportedWorkflowError(err: unknown): boolean {
  if (!isApiError(err) || err.status !== 400) return false;
  const body = err.body as { error?: { details?: { reason?: string } } } | undefined;
  return body?.error?.details?.reason === 'weldconnect_unsupported';
}
