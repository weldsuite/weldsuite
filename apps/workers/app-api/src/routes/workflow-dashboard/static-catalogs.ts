/**
 * Static catalogs returned by /api/workflow-dashboard/{action-types,trigger-types,entity-events}.
 * Lifted verbatim from the legacy api-worker dashboard so the editor's
 * picker UIs render identically after the cutover.
 *
 * `ENTITY_EVENTS` below is the lone exception. The set of selectable objects
 * is a curated short-list (the most-used WeldSuite objects) — but each
 * object's *events* are derived from the `@weldsuite/entity-events` catalog,
 * the same source of truth `publishEntityEvent` narrows against, so the
 * offered events can never drift from what actually fires. To expose more
 * objects, add their entity type to `BASIC_TRIGGER_OBJECTS`.
 */

import { ENTITY_EVENTS as ENTITY_EVENT_CATALOG, type EntityType } from '@weldsuite/entity-events';
import { deriveActionTypes, deriveIntegrationTriggerTypes } from '@weldsuite/workflow-integrations/catalog';

const BUILTIN_ACTION_TYPES = [
  // Communication
  { id: 'send_email', name: 'Send Email', description: 'Send an email message', category: 'communication', icon: 'mail' },
  { id: 'send_sms', name: 'Send SMS', description: 'Send an SMS message', category: 'communication', icon: 'message-square' },
  { id: 'send_notification', name: 'Send Notification', description: 'Send a push notification', category: 'communication', icon: 'bell' },
  { id: 'slack_message', name: 'Slack Message', description: 'Send a message to Slack', category: 'communication', icon: 'slack' },
  // Data
  { id: 'create_record', name: 'Create Record', description: 'Create a new database record', category: 'data', icon: 'plus' },
  { id: 'update_record', name: 'Update Record', description: 'Update an existing record', category: 'data', icon: 'edit' },
  { id: 'delete_record', name: 'Delete Record', description: 'Delete a record', category: 'data', icon: 'trash' },
  { id: 'query_data', name: 'Query Data', description: 'Query and filter data', category: 'data', icon: 'search' },
  // Logic
  { id: 'condition', name: 'Condition', description: 'Branch based on conditions', category: 'logic', icon: 'git-branch' },
  { id: 'loop', name: 'Loop', description: 'Iterate over a list', category: 'logic', icon: 'repeat' },
  { id: 'delay', name: 'Delay', description: 'Wait for a specified time', category: 'logic', icon: 'clock' },
  { id: 'transform', name: 'Transform Data', description: 'Transform data using expressions', category: 'logic', icon: 'shuffle' },
  // Integration
  { id: 'http_request', name: 'HTTP Request', description: 'Make an HTTP request', category: 'integration', icon: 'globe' },
  { id: 'webhook', name: 'Call Webhook', description: 'Call a webhook URL', category: 'integration', icon: 'webhook' },
  // AI
  { id: 'ai_generate', name: 'AI Generate', description: 'Generate text with AI', category: 'ai', icon: 'sparkles' },
  { id: 'ai_classify', name: 'AI Classify', description: 'Classify content with AI', category: 'ai', icon: 'tag' },
  { id: 'ai_auto_reply', name: 'AI Auto-Reply', description: 'Generate and send an AI-powered reply to a conversation', category: 'helpdesk', icon: 'bot' },
  // Chat widget interactive steps
  { id: 'send_message', name: 'Send Bot Message', description: 'Send a message to the customer in chat', category: 'helpdesk', icon: 'message-square-text' },
  { id: 'send_choices', name: 'Send Choices', description: 'Send multiple choice options to the customer', category: 'helpdesk', icon: 'list-checks' },
  { id: 'collect_input', name: 'Collect Input', description: 'Ask the customer for information', category: 'helpdesk', icon: 'clipboard-list' },
];

/** Built-in actions + the namespaced actions contributed by connected
 *  third-party integrations (Slack, Google Sheets, …) from the catalog package. */
export const ACTION_TYPES = [...BUILTIN_ACTION_TYPES, ...deriveActionTypes()];

const BUILTIN_TRIGGER_TYPES = [
  { id: 'schedule', name: 'Schedule', description: 'Run on a schedule', category: 'schedule', icon: 'calendar' },
  { id: 'cron', name: 'Cron Expression', description: 'Run based on cron expression', category: 'schedule', icon: 'clock' },
  { id: 'entity_created', name: 'Record Created', description: 'Trigger when a record is created', category: 'entity', icon: 'plus' },
  { id: 'entity_updated', name: 'Record Updated', description: 'Trigger when a record is updated', category: 'entity', icon: 'edit' },
  { id: 'entity_deleted', name: 'Record Deleted', description: 'Trigger when a record is deleted', category: 'entity', icon: 'trash' },
  { id: 'webhook', name: 'Webhook', description: 'Trigger via HTTP webhook', category: 'webhook', icon: 'webhook' },
  { id: 'manual', name: 'Manual', description: 'Trigger manually', category: 'manual', icon: 'hand' },
  { id: 'api', name: 'API Call', description: 'Trigger via API', category: 'api', icon: 'code' },
];

/** Built-in triggers + the integration_event triggers (Slack message, Sheets
 *  new row, …) contributed by the catalog package. */
export const TRIGGER_TYPES = [...BUILTIN_TRIGGER_TYPES, ...deriveIntegrationTriggerTypes()];

// Word casing that simple title-casing gets wrong (action names).
const ACRONYMS: Record<string, string> = {
  vat: 'VAT',
  sla: 'SLA',
};

function humanizeWord(word: string): string {
  return ACRONYMS[word] ?? word.charAt(0).toUpperCase() + word.slice(1);
}

/** `stage_changed` → "Stage Changed". */
function humanize(value: string): string {
  return value.split('_').map(humanizeWord).join(' ');
}

// Grammatical phrasing for the common physical actions; everything else
// falls back to a generic phrase. Descriptions aren't shown in the current
// pickers (only `name` is), but we keep them meaningful for API consumers.
const ACTION_PHRASES: Record<string, string> = {
  created: 'is created',
  updated: 'is updated',
  deleted: 'is deleted',
  archived: 'is archived',
  unarchived: 'is unarchived',
  completed: 'is completed',
  cancelled: 'is cancelled',
  placed: 'is placed',
  assigned: 'is assigned',
  escalated: 'is escalated',
  resolved: 'is resolved',
  closed: 'is closed',
  paid: 'is paid',
  overdue: 'becomes overdue',
  sent: 'is sent',
  won: 'is won',
  lost: 'is lost',
  converted: 'is converted',
  qualified: 'is qualified',
  approved: 'is approved',
  rejected: 'is rejected',
  status_changed: 'status changes',
  stage_changed: 'stage changes',
  priority_changed: 'priority changes',
  tagged: 'is tagged',
};

function actionDescription(label: string, action: string): string {
  const phrase = ACTION_PHRASES[action];
  return phrase
    ? `When a ${label.toLowerCase()} ${phrase}`
    : `When a ${label.toLowerCase()} "${humanize(action)}" event occurs`;
}

export interface EntityEventCatalogEntry {
  entityType: string;
  category: string;
  label: string;
  events: Array<{ id: string; name: string; description: string }>;
}

/**
 * Curated short-list of the most-used WeldSuite objects offered as
 * `entity_event` triggers. `entityType` must exist in the events catalog
 * (its events are pulled from there). Order here is the display order.
 * NOTE: `contact` and `customer` are intentionally absent — they are no
 * longer first-class objects (CRM uses `person` / `company`).
 */
const BASIC_TRIGGER_OBJECTS: Array<{ entityType: EntityType; category: string; label: string }> = [
  { entityType: 'lead', category: 'CRM', label: 'Lead' },
  { entityType: 'opportunity', category: 'CRM', label: 'Opportunity' },
  { entityType: 'company', category: 'CRM', label: 'Company' },
  { entityType: 'person', category: 'CRM', label: 'Person' },
  { entityType: 'project', category: 'Projects', label: 'Project' },
  { entityType: 'project_task', category: 'Projects', label: 'Task' },
  { entityType: 'ticket', category: 'Helpdesk', label: 'Ticket' },
  { entityType: 'invoice', category: 'Accounting', label: 'Invoice' },
  { entityType: 'commerce_order', category: 'Commerce', label: 'Order' },
  { entityType: 'product', category: 'Commerce', label: 'Product' },
];

function buildEntityEvents(): EntityEventCatalogEntry[] {
  return BASIC_TRIGGER_OBJECTS.map(({ entityType, category, label }) => {
    const actions = (ENTITY_EVENT_CATALOG[entityType] ?? []) as readonly string[];
    return {
      entityType,
      category,
      label,
      events: actions.map((action) => ({
        id: action,
        name: `${label} ${humanize(action)}`,
        description: actionDescription(label, action),
      })),
    };
  });
}

export const ENTITY_EVENTS: EntityEventCatalogEntry[] = buildEntityEvents();
