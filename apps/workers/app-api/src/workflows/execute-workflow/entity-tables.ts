/**
 * Entity table mapping for workflow CRUD actions.
 * Maps entity type names to Drizzle schema tables.
 *
 * Ported from apps/api-worker/src/workflows/execute-workflow/entity-tables.ts
 * (W4 legacy-worker phase-out) — only the schema import path changed.
 */

import { schema } from '../../db';

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
  const normalizedType = entityType.toLowerCase().replace(/-/g, '_');
  const table = entityTableMap[normalizedType];
  if (!table) {
    throw new Error(`Unknown entity type: ${entityType}. Available: ${Object.keys(entityTableMap).join(', ')}`);
  }
  return table;
}

export function getEntityIdPrefix(entityType: string): string {
  const normalizedType = entityType.toLowerCase().replace(/-/g, '_');
  return entityIdPrefixMap[normalizedType] || normalizedType.slice(0, 3);
}
