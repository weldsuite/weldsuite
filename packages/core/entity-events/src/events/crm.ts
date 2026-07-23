/**
 * WeldCRM entity events.
 *
 * Each entry maps an entityType to the subscribable actions for that
 * entity. The list combines the physical actions emitted by publishers
 * with the derived subscription actions agents/workflows can listen to
 * (e.g. opportunity.won is derived from opportunity:updated + a status
 * change inside agent-dispatch).
 */
export const CRM_ENTITY_EVENTS = {
  customer: ['created', 'updated', 'deleted', 'archived'],
  contact: ['created', 'updated', 'deleted', 'archived'],
  person: ['created', 'updated', 'deleted', 'archived', 'unarchived'],
  contact_link: ['created', 'deleted'],
  company: ['created', 'updated', 'deleted', 'archived'],
  lead: ['created', 'updated', 'deleted', 'archived', 'converted', 'qualified'],
  opportunity: [
    'created',
    'updated',
    'deleted',
    'archived',
    'won',
    'lost',
    'stage_changed',
  ],
  activity: ['created', 'updated', 'deleted', 'completed'],
  supplier: ['created', 'updated', 'deleted', 'archived'],
  customer_list: ['created', 'updated', 'deleted'],
  pipeline: ['created', 'updated', 'deleted'],
  pipeline_stage: ['created', 'updated', 'deleted'],
  custom_field: ['created', 'updated', 'deleted'],
  object_template: ['created', 'updated', 'deleted'],
  enrich_field: ['created', 'updated', 'deleted'],
  sequence: ['created', 'updated', 'deleted'],
  call: ['created', 'updated', 'deleted'],
  transcription: ['created', 'updated', 'deleted'],
  meeting_bot_session: ['created', 'updated', 'deleted'],
  customer_status: ['created', 'updated', 'deleted'],
  analytics_report: ['created', 'updated', 'deleted'],
} as const;
