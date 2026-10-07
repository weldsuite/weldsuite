/**
 * WeldConnect MVP scope — the triggers and actions the WeldConnect editor
 * offers. The engine supports more (shared with WeldDesk workflows and CRM
 * sequences), but WeldConnect only exposes what's production-ready.
 *
 * Keep in sync with the server-side activation gate in
 * apps/workers/connect-api/src/services/weldconnect-mvp.ts, which rejects
 * activating a workflow that uses anything else.
 */

import { isApiError } from '@weldsuite/api-client';

export const WELDCONNECT_TRIGGER_TYPES = [
  'entity_event',
  'schedule',
  'webhook',
  'workflow_complete',
] as const;

/** Only recurring schedules are supported (the cron sweep has no one-off runs). */
export const WELDCONNECT_SCHEDULE_TYPES = ['recurring'] as const;

export const WELDCONNECT_ACTION_TYPES = [
  'send_email',
  'create_customer',
  'create_contact',
  'update_contact',
  'create_lead',
  'create_deal',
  'move_deal_stage',
  'log_activity',
  'create_task',
  'send_notification',
  'post_chat_message',
  'http_request',
  // AI steps, metered against the workspace credit wallet (@weldsuite/credits).
  'ai_generate',
  'ai_classify',
  'condition',
  'loop',
  'delay',
  // First third-party provider action — see "Provider pattern" in
  // docs/plans/weldconnect.md for what Google/GitHub add alongside this.
  'slack.post_message',
  // GitHub (app_installation auth — reuses WeldFlow's existing GitHub App
  // installation instead of a second OAuth app or a PAT).
  'github.create_issue',
  'github.create_comment',
  'manual_step',
] as const;

/**
 * Sections under /weldconnect that exist but are outside the MVP: hidden from
 * the sidebar (hooks/use-weldconnect-sidebar-items.tsx) and, for anyone who
 * still lands on them through an old link, marked with a notice saying that
 * nothing set up there can be used in a workflow yet. Integrations and
 * connectors are not listed: Settings links to them and they work on their own.
 *
 * `actions` / `triggers` are static reference catalogs (connect-api
 * workflow-dashboard/static-catalogs.ts) with placeholder fields (premium,
 * usage counts, inputs/outputs) nothing backs; the editor already offers
 * exactly what can go live. `templates` is being rebuilt server-side.
 */
export const WELDCONNECT_OUT_OF_SCOPE_SECTIONS = [
  'actions',
  'templates',
  'triggers',
] as const;

/** CRM sequences are `workflows` rows too; WeldConnect lists exclude them. */
export const SEQUENCE_WORKFLOW_TAG = '__type:sequence';

/** True when app-api refused to activate a workflow because it's outside the MVP scope. */
export function isUnsupportedWorkflowError(err: unknown): boolean {
  if (!isApiError(err) || err.status !== 400) return false;
  const body = err.body as { error?: { details?: { reason?: string } } } | undefined;
  return body?.error?.details?.reason === 'weldconnect_unsupported';
}

/**
 * The reasons the activation gate gave for refusing a workflow (`no_trigger`,
 * `invalid_cron`, `unsupported_action`, …; see `WorkflowIssueCode` in the
 * server-side gate). Empty when the error is something else.
 */
export function getWorkflowIssueCodes(err: unknown): string[] {
  if (!isApiError(err) || err.status !== 400) return [];
  const body = err.body as { error?: { details?: { issues?: Array<{ code?: unknown }> } } } | undefined;
  const issues = body?.error?.details?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.map((issue) => issue?.code).filter((code): code is string => typeof code === 'string');
}
