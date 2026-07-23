import type { EntityEventMessage } from '../lib/entity-events';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnalyticsRecord {
  workspace_id: string;
  module: string;
  entity_type: string;
  action: string;
  event_date: string;
  entity_id: string;
  user_id: string;
  count: number;
  status?: string;
  priority?: string;
  channel?: string;
  category?: string;
  assignee_id?: string;
  source?: string;
  stage?: string;
  sub_status?: string;
  project_id?: string;
  risk_level?: string;
  amount?: number;
  duration_seconds?: number;
  score?: number;
  is_escalated?: number;
  is_qualified?: number;
  is_converted?: number;
  is_completed?: number;
  is_overdue?: number;
  is_billable?: number;
  estimated_hours?: number;
  actual_hours?: number;
  progress?: number;
  probability?: number;
  weighted_amount?: number;
  message_count?: number;
  response_time_seconds?: number;
  resolution_time_seconds?: number;
}

// ---------------------------------------------------------------------------
// Entity config map (enrichment for known entities)
// ---------------------------------------------------------------------------

interface StringField {
  source: string;
  target: keyof AnalyticsRecord;
}

interface NumericField {
  target: keyof AnalyticsRecord;
  boolean?: true;
  statusCheck?: string[];
  exists?: true;
  field?: string;
}

interface EntityConfig {
  module: string;
  entityType: string;
  strings: StringField[];
  numerics: NumericField[];
}

const ENTITY_CONFIG: Record<string, EntityConfig> = {
  helpdesk_ticket: {
    module: 'helpdesk',
    entityType: 'ticket',
    strings: [
      { source: 'status', target: 'status' },
      { source: 'priority', target: 'priority' },
      { source: 'channel', target: 'channel' },
      { source: 'category', target: 'category' },
      { source: 'assigneeId', target: 'assignee_id' },
    ],
    numerics: [
      { target: 'is_escalated', field: 'isEscalated', boolean: true },
      { target: 'is_completed', statusCheck: ['closed', 'resolved'] },
      { target: 'response_time_seconds', field: 'responseTime' },
      { target: 'resolution_time_seconds', field: 'resolutionTime' },
    ],
  },
  helpdesk_conversation: {
    module: 'helpdesk',
    entityType: 'conversation',
    strings: [
      { source: 'status', target: 'status' },
      { source: 'channel', target: 'channel' },
      { source: 'assigneeId', target: 'assignee_id' },
    ],
    numerics: [],
  },
  helpdesk_conversation_message: {
    module: 'helpdesk',
    entityType: 'conversation_message',
    strings: [
      { source: 'channel', target: 'channel' },
    ],
    numerics: [
      { target: 'message_count', field: '_count' },
    ],
  },
  helpdesk_message: {
    module: 'helpdesk',
    entityType: 'message',
    strings: [],
    numerics: [
      { target: 'message_count', field: '_count' },
    ],
  },
  helpdesk_contact: {
    module: 'helpdesk',
    entityType: 'contact',
    strings: [],
    numerics: [],
  },
  helpdesk_agent: {
    module: 'helpdesk',
    entityType: 'agent',
    strings: [],
    numerics: [],
  },
  helpdesk_article: {
    module: 'helpdesk',
    entityType: 'article',
    strings: [
      { source: 'status', target: 'status' },
      { source: 'category', target: 'category' },
    ],
    numerics: [],
  },
  helpdesk_folder: {
    module: 'helpdesk',
    entityType: 'folder',
    strings: [],
    numerics: [],
  },
  helpdesk_news: {
    module: 'helpdesk',
    entityType: 'news',
    strings: [
      { source: 'status', target: 'status' },
    ],
    numerics: [],
  },
  helpdesk_workflow: {
    module: 'helpdesk',
    entityType: 'workflow',
    strings: [],
    numerics: [],
  },
  helpdesk_settings: {
    module: 'helpdesk',
    entityType: 'settings',
    strings: [],
    numerics: [],
  },
  department: {
    module: 'helpdesk',
    entityType: 'department',
    strings: [],
    numerics: [],
  },
  lead: {
    module: 'crm',
    entityType: 'lead',
    strings: [
      { source: 'status', target: 'status' },
      { source: 'source', target: 'source' },
    ],
    numerics: [
      { target: 'score', field: 'score' },
      { target: 'is_qualified', field: 'isQualified', boolean: true },
      { target: 'is_converted', field: 'convertedAt', exists: true },
    ],
  },
  opportunity: {
    module: 'crm',
    entityType: 'opportunity',
    strings: [
      { source: 'status', target: 'status' },
      { source: 'stage', target: 'stage' },
    ],
    numerics: [
      { target: 'amount', field: 'amount' },
      { target: 'probability', field: 'probability' },
      { target: 'weighted_amount', field: 'weightedAmount' },
      { target: 'is_converted', field: 'wonAt', exists: true },
    ],
  },
  activity: {
    module: 'crm',
    entityType: 'activity',
    strings: [
      { source: 'status', target: 'status' },
      { source: 'category', target: 'category' },
      { source: 'assigneeId', target: 'assignee_id' },
    ],
    numerics: [
      { target: 'is_completed', statusCheck: ['completed', 'done'] },
      { target: 'is_overdue', field: 'isOverdue', boolean: true },
      { target: 'duration_seconds', field: 'durationSeconds' },
    ],
  },
  project_task: {
    module: 'projects',
    entityType: 'task',
    strings: [
      { source: 'status', target: 'status' },
      { source: 'priority', target: 'priority' },
      { source: 'assigneeId', target: 'assignee_id' },
      { source: 'projectId', target: 'project_id' },
    ],
    numerics: [
      { target: 'is_completed', statusCheck: ['done', 'completed', 'closed'] },
      { target: 'is_overdue', field: 'isOverdue', boolean: true },
      { target: 'estimated_hours', field: 'estimatedHours' },
      { target: 'actual_hours', field: 'actualHours' },
      { target: 'progress', field: 'progress' },
    ],
  },
  project_time_entry: {
    module: 'projects',
    entityType: 'time_entry',
    strings: [
      { source: 'projectId', target: 'project_id' },
      { source: 'assigneeId', target: 'assignee_id' },
    ],
    numerics: [
      { target: 'duration_seconds', field: 'durationSeconds' },
      { target: 'is_billable', field: 'isBillable', boolean: true },
      { target: 'actual_hours', field: 'actualHours' },
    ],
  },
};

// ---------------------------------------------------------------------------
// Derive module from entityType prefix for unknown entities
// ---------------------------------------------------------------------------

function deriveModule(entityType: string): string {
  if (entityType.startsWith('helpdesk_')) return 'helpdesk';
  if (entityType.startsWith('project_')) return 'projects';
  if (entityType === 'lead' || entityType === 'opportunity' || entityType === 'activity') return 'crm';
  if (entityType.startsWith('crm_')) return 'crm';
  if (entityType.startsWith('wms_')) return 'wms';
  if (entityType.startsWith('commerce_')) return 'commerce';
  if (entityType.startsWith('parcel_')) return 'parcel';
  if (entityType.startsWith('mail_')) return 'mail';
  if (entityType.startsWith('accounting_')) return 'accounting';
  if (entityType.startsWith('personal_')) return 'task';
  return 'other';
}

// ---------------------------------------------------------------------------
// Transformer — writes ALL events, enriches known entity types
// ---------------------------------------------------------------------------

export function transformEvent(event: EntityEventMessage): AnalyticsRecord {
  const config = ENTITY_CONFIG[event.entityType];
  const data = event.data as Record<string, unknown>;
  const date = event.metadata.timestamp.split('T')[0];

  const record: AnalyticsRecord = {
    workspace_id: event.metadata.workspaceId,
    module: config?.module ?? deriveModule(event.entityType),
    entity_type: config?.entityType ?? event.entityType,
    action: event.action,
    event_date: date,
    entity_id: String(event.entityId),
    user_id: event.metadata.userId,
    count: 1,
  };

  // Auto-extract common fields from data even without config
  if (data['status'] != null) record.status = String(data['status']);
  if (data['priority'] != null) record.priority = String(data['priority']);
  if (data['assigneeId'] != null) record.assignee_id = String(data['assigneeId']);
  if (data['projectId'] != null) record.project_id = String(data['projectId']);
  if (data['channel'] != null) record.channel = String(data['channel']);
  if (data['category'] != null) record.category = String(data['category']);
  if (data['source'] != null) record.source = String(data['source']);
  if (data['stage'] != null) record.stage = String(data['stage']);

  // Apply config-specific string overrides (in case field names differ)
  if (config) {
    for (const field of config.strings) {
      const value = data[field.source];
      if (value != null) {
        (record as any)[field.target] = String(value);
      }
    }

    // Apply numeric measures
    for (const field of config.numerics) {
      const sourceField = field.field ?? field.target;
      const value = data[sourceField];

      if (field.boolean) {
        (record as any)[field.target] = value ? 1 : 0;
      } else if (field.statusCheck) {
        const status = String(data['status'] ?? '').toLowerCase();
        (record as any)[field.target] = field.statusCheck.includes(status) ? 1 : 0;
      } else if (field.exists) {
        (record as any)[field.target] = value != null ? 1 : 0;
      } else if (typeof value === 'number') {
        (record as any)[field.target] = value;
      }
    }
  }

  return record;
}
