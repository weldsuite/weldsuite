/**
 * Rows the tests and the Rust parity fixtures start from, as SQL, so the Rust
 * side (`rust/crates/desk-domain/tests/workflow_parity.rs`) seeds the very same
 * rows. Fixed ids and times; every statement can run again (they clear what
 * they insert first).
 */

/** The tables the engine reads and writes, cleared before each scenario. */
export const ENGINE_TABLES = [
  'helpdesk_workflow_executions',
  'helpdesk_conversation_messages',
  'helpdesk_satisfaction_surveys',
  'helpdesk_conversations',
  'helpdesk_workflows',
  'helpdesk_agents',
  'helpdesk_articles',
  'helpdesk_channel_integrations',
] as const;

export const CLEAR: string[] = ENGINE_TABLES.map((table) => `delete from ${table}`);

/** One conversation, `hc_1`, open, with a contact and a tag. */
export const CONVERSATION = `insert into helpdesk_conversations
  (id, created_at, updated_at, conversation_number, contact_id, customer_name, customer_email, subject,
   status, priority, assignee_id, assignee_name, department_id, channel, message_count, unread_count,
   tags, is_read, metadata)
  values ('hc_1', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z', 'C-1001', 'con_1', 'Jane Doe',
   'jane@example.com', 'Order missing', 'open', 'medium', null, null, null, 'chat', 2, 1,
   '["vip"]'::jsonb, false, '{}'::jsonb)`;

/** A second conversation on another channel, `hc_2`, with Discord and Slack ids. */
export const CONVERSATION_DISCORD = `insert into helpdesk_conversations
  (id, created_at, updated_at, conversation_number, customer_name, subject, status, channel,
   message_count, metadata)
  values ('hc_2', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z', 'C-1002', 'Bob', 'Login help',
   'open', 'discord', 0, '{"discordChannelId":"dc_77","slackChannelId":"sc_88","slackThreadTs":"171.5"}'::jsonb)`;

/** Agents for the round-robin / least-busy assignment. */
export const AGENTS = `insert into helpdesk_agents
  (id, created_at, updated_at, user_id, name, email, status, department_id, current_active_tickets, tickets_assigned)
  values
  ('hag_1', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z', 'user_ann', 'Ann', 'ann@example.com', 'active', 'dep_1', 3, 10),
  ('hag_2', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z', 'user_bob', 'Bob', 'bob@example.com', 'active', 'dep_1', 1, 12),
  ('hag_3', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z', 'user_cy', 'Cy', 'cy@example.com', 'active', 'dep_2', 0, 4),
  ('hag_4', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z', 'user_dee', 'Dee', 'dee@example.com', 'inactive', 'dep_1', 0, 0)`;

/** Published and draft articles for `suggest_articles`. */
export const ARTICLES = `insert into helpdesk_articles
  (id, created_at, updated_at, title, slug, content, excerpt, author_id, status)
  values
  ('har_1', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z', 'Reset your password', 'reset-password', 'x', 'Forgot it? 100% fixable', 'user_ann', 'published'),
  ('har_2', '2026-10-02T09:00:00Z', '2026-10-02T09:00:00Z', 'Shipping times', 'shipping', 'x', null, 'user_ann', 'published'),
  ('har_3', '2026-10-03T09:00:00Z', '2026-10-03T09:00:00Z', 'Password policy (draft)', 'policy', 'x', 'password rules', 'user_ann', 'draft')`;

/** A connected Slack integration with a bot token. */
export const SLACK = `insert into helpdesk_channel_integrations
  (id, created_at, updated_at, provider, name, status, config)
  values ('hci_1', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z', 'slack', 'Slack', 'connected',
   '{"botToken":"xoxb-test"}'::jsonb)`;

/** A `helpdesk_workflows` row. */
export function workflowRow(row: {
  id: string;
  name: string;
  status?: string;
  sortOrder?: number;
  triggers: unknown;
  steps: unknown;
  deleted?: boolean;
}): string {
  const json = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
  return `insert into helpdesk_workflows (id, created_at, updated_at, deleted_at, name, status, version, sort_order, triggers, steps)
    values ('${row.id}', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z', ${row.deleted ? "'2026-10-02T09:00:00Z'" : 'null'},
    '${row.name.replaceAll("'", "''")}', '${row.status ?? 'active'}', 1, ${row.sortOrder ?? 0}, ${json(row.triggers)}, ${json(row.steps)})`;
}

/** An entity-event trigger on new conversations, optionally for some channels only. */
export function onCreated(channels?: string[]) {
  return [
    {
      id: 'trg_1',
      type: 'entity_event',
      isEnabled: true,
      config: { entityType: 'helpdesk_conversation', eventType: 'created', ...(channels ? { channels } : {}) },
    },
  ];
}

/** A `helpdesk_workflow_executions` row in a given state. */
export function executionRow(row: {
  id: string;
  workflowId: string;
  conversationId: string;
  status: string;
  context?: unknown;
}): string {
  const context = row.context === undefined ? 'null' : `'${JSON.stringify(row.context)}'::jsonb`;
  return `insert into helpdesk_workflow_executions (id, helpdesk_workflow_id, workflow_name, status, conversation_id, channel, execution_context)
    values ('${row.id}', '${row.workflowId}', 'Seeded', '${row.status}', '${row.conversationId}', 'chat', ${context})`;
}
