/**
 * Entity table mapping for workflow CRUD actions.
 * Maps entity type names to Drizzle schema tables.
 *
 * Ported from apps/api-worker/src/workflows/execute-workflow/entity-tables.ts
 * (W4 legacy-worker phase-out) — only the schema import path changed.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const entityTableMap: Record<string, any> = {
  // CRM
  lead: schema.crmLeads,
  crm_lead: schema.crmLeads,
  customer: schema.companies,
  company: schema.companies,
  contact: schema.people,
  person: schema.people,
  opportunity: schema.crmOpportunities,
  crm_opportunity: schema.crmOpportunities,
  activity: schema.crmActivities,
  crm_activity: schema.crmActivities,
  pipeline_stage: schema.crmPipelineStages,

  // Helpdesk
  ticket: schema.helpdeskTickets,
  helpdesk_ticket: schema.helpdeskTickets,
  ticket_message: schema.helpdeskTicketMessages,
  department: schema.helpdeskDepartments,
  helpdesk_department: schema.helpdeskDepartments,
  canned_response: schema.helpdeskCannedResponses,

  // Catalog & orders (shared)
  order: schema.orders,
  product: schema.products,
  category: schema.categories,

  // Projects
  project: schema.projects,
  task: schema.tasks,
  milestone: schema.milestones,
  time_entry: schema.timeEntries,
  project_file: schema.projectFiles,
  project_member: schema.projectMembers,

  // Mail
  mail_account: schema.mailAccounts,
  mail_message: schema.mailMessages,
  mail_folder: schema.mailFolders,
  mail_template: schema.mailTemplates,

  // Workflow
  workflow: schema.workflows,
  workflow_execution: schema.workflowExecutions,
  workflow_schedule: schema.workflowSchedules,
  workflow_variable: schema.workflowVariables,
  workflow_webhook: schema.workflowWebhooks,
  workflow_integration: schema.workflowIntegrations,

  // Host
  host_domain: schema.hostDomains,
};

const entityIdPrefixMap: Record<string, string> = {
  lead: 'led', crm_lead: 'led', customer: 'cus', contact: 'con',
  opportunity: 'opp', crm_opportunity: 'opp', activity: 'act', crm_activity: 'act',
  pipeline_stage: 'pst', ticket: 'tkt', helpdesk_ticket: 'tkt',
  ticket_message: 'tmg', department: 'dep', canned_response: 'crs',
  order: 'ord', product: 'prd', category: 'cat',
  project: 'prj', task: 'tsk', milestone: 'mls', time_entry: 'ten',
  project_file: 'pfl', project_member: 'pmb',
  mail_account: 'mac', mail_message: 'mmsg', mail_folder: 'mfl', mail_template: 'mtp',
  workflow: 'wfl', workflow_execution: 'wex', workflow_schedule: 'wsc',
  workflow_variable: 'wvr', workflow_webhook: 'wwh', workflow_integration: 'win',
  host_domain: 'hdo',
};

export function getEntityTable(entityType: string): any {
  const normalizedType = entityType.toLowerCase().replaceAll('-', '_');
  const table = entityTableMap[normalizedType];
  if (!table) {
    throw new Error(`Unknown entity type: ${entityType}. Available: ${Object.keys(entityTableMap).join(', ')}`);
  }
  return table;
}

export function getEntityIdPrefix(entityType: string): string {
  const normalizedType = entityType.toLowerCase().replaceAll('-', '_');
  return entityIdPrefixMap[normalizedType] || normalizedType.slice(0, 3);
}

// ---------------------------------------------------------------------------
// MAIL-003 for generic record actions
// ---------------------------------------------------------------------------

/**
 * Mail entities a sequence's generic `create_record` / `update_record` /
 * `delete_record` / `query_data` steps can reach, and the column each uses to
 * tie back to a mailbox. `mail_account` IS the mailbox; `mail_message` and
 * `mail_folder` belong to one through `accountId`.
 */
const MAIL_ENTITY_ACCOUNT_COLUMN: Record<string, 'id' | 'accountId'> = {
  mail_account: 'id',
  mail_message: 'accountId',
  mail_folder: 'accountId',
};

function mailAccountColumnOf(entityType: string): 'id' | 'accountId' | undefined {
  return MAIL_ENTITY_ACCOUNT_COLUMN[entityType.toLowerCase().replaceAll('-', '_')];
}

/**
 * MAIL-003 (`@weldsuite/mail-domain/access`) says mailbox access follows
 * sharing and per-user assignment, and the admin/owner role alone never opens
 * a private mailbox. A sequence run acts for no member, so it can satisfy
 * neither test. The least-breaking scope left for a *generic* record action is
 * "shared mailboxes only" — the same scope a workspace API key or WeldApp
 * token gets (`MailPrincipal.kind === 'workspace'` in mail-domain/access).
 * Dedicated mail actions that already run as a member (`send_email`, …) are
 * untouched; this only gates the generic CRUD actions in `action-handlers.ts`.
 *
 * Returns the extra WHERE condition for `update_record` / `delete_record` /
 * `query_data` (AND it with the caller's other conditions), or `undefined`
 * when `entityType` isn't one of the mail entities above. `mail_account`
 * checks its own `isShared`; `mail_message` / `mail_folder` check it through
 * the pre-fetched set of shared account ids. `table`/return typed `any` like
 * the rest of this file: Drizzle's overloads cannot express a runtime table.
 */
export async function sharedMailboxCondition(
  db: Database,
  entityType: string,
  table: any,
): Promise<any> {
  const column = mailAccountColumnOf(entityType);
  if (!column) return undefined;
  if (column === 'id') return eq(table.isShared, true);

  const shared = await db
    .select({ id: schema.mailAccounts.id })
    .from(schema.mailAccounts)
    .where(and(eq(schema.mailAccounts.isShared, true), isNull(schema.mailAccounts.deletedAt)));
  const ids = shared.map((row) => row.id);
  // No shared mailbox must mean no rows, never "no filter" — mirrors
  // `accountScopeCondition` in `@weldsuite/mail-domain/access`.
  return ids.length === 0 ? sql`false` : inArray(table.accountId, ids);
}

/**
 * `create_record` has no existing row to test, so it validates the write
 * instead: `mail_message` / `mail_folder` must name an existing shared
 * account; `mail_account` may only be created shared in the first place
 * (there is no workspace member for a sequence to assign a private one to —
 * see {@link mailEntityCreateOverrides}). Throws when the data doesn't satisfy
 * that; a no-op for every other entity type.
 */
export async function assertMailEntityCreatable(
  db: Database,
  entityType: string,
  data: Record<string, unknown>,
): Promise<void> {
  const column = mailAccountColumnOf(entityType);
  if (!column) return;
  if (column === 'id') {
    if (data.isShared === false) {
      throw new Error(
        'A workflow can only create a shared mail account: there is no workspace member to assign a private one to',
      );
    }
    return;
  }

  const accountId = data[column];
  if (typeof accountId !== 'string' || !accountId) {
    throw new Error(`${entityType} requires ${column}`);
  }
  const [account] = await db
    .select({ isShared: schema.mailAccounts.isShared })
    .from(schema.mailAccounts)
    .where(and(eq(schema.mailAccounts.id, accountId), isNull(schema.mailAccounts.deletedAt)));
  if (!account?.isShared) {
    throw new Error(
      `Mail account ${accountId} is not a shared mailbox; a workflow may only write to shared mailboxes (MAIL-003)`,
    );
  }
}

/**
 * `mail_account` always creates shared — see {@link assertMailEntityCreatable}.
 * Spread into the insert data AFTER the caller's own `data`, so it wins over
 * whatever the step passed (or the schema's `isShared: false` default).
 */
export function mailEntityCreateOverrides(entityType: string): Record<string, unknown> | undefined {
  return mailAccountColumnOf(entityType) === 'id' ? { isShared: true } : undefined;
}
