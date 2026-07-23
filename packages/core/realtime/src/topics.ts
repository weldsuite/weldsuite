/**
 * Topic name helpers for WorkspaceHub subscriptions.
 *
 * Topics use dot-separated hierarchy. Subscribing to a parent
 * matches all children: "project" matches "project.proj_123".
 */

export const topics = {
  // Entity events
  project: (id?: string) => (id ? `project.${id}` : 'project'),
  task: (id?: string) => (id ? `task.${id}` : 'task'),
  contact: (id?: string) => (id ? `contact.${id}` : 'contact'),
  company: (id?: string) => (id ? `company.${id}` : 'company'),
  person: (id?: string) => (id ? `person.${id}` : 'person'),
  lead: (id?: string) => (id ? `lead.${id}` : 'lead'),
  opportunity: (id?: string) => (id ? `opportunity.${id}` : 'opportunity'),
  activity: (id?: string) => (id ? `activity.${id}` : 'activity'),
  pipeline: (id?: string) => (id ? `pipeline.${id}` : 'pipeline'),
  pipelineStage: (id?: string) => (id ? `pipeline_stage.${id}` : 'pipeline_stage'),
  sequence: (id?: string) => (id ? `sequence.${id}` : 'sequence'),
  product: (id?: string) => (id ? `product.${id}` : 'product'),
  inventory: (id?: string) => (id ? `inventory.${id}` : 'inventory'),
  invoice: (id?: string) => (id ? `invoice.${id}` : 'invoice'),
  bill: (id?: string) => (id ? `bill.${id}` : 'bill'),
  payment: (id?: string) => (id ? `payment.${id}` : 'payment'),
  commerceOrder: (id?: string) => (id ? `commerce_order.${id}` : 'commerce_order'),
  ticket: (id?: string) => (id ? `ticket.${id}` : 'ticket'),

  // Workspace features
  mail: (userId: string) => `mail.${userId}`,
  notification: (userId?: string) => (userId ? `notification.${userId}` : 'notification'),
  inbox: (agentId?: string) => (agentId ? `inbox.${agentId}` : 'inbox'),
  helpdesk: () => 'helpdesk',
  support: () => 'support',

  // Workspace presence (online/away/dnd/offline status changes)
  presence: () => 'presence',

  // WeldChat user events (via WorkspaceHub)
  chatUser: (userId: string) => `chat.user.${userId}`,

  // WeldMeet events
  meeting: (id?: string) => (id ? `meeting.${id}` : 'meeting'),
  meetingUser: (userId: string) => `meeting.user.${userId}`,

  // WeldConnect workflow execution events
  workflowExecution: (executionId?: string) =>
    executionId ? `workflow_execution.${executionId}` : 'workflow_execution',
} as const;

/**
 * Check if an event topic matches a subscription topic.
 * "project" matches "project" and "project.proj_123".
 */
export function topicMatches(subscription: string, eventTopic: string): boolean {
  return eventTopic === subscription || eventTopic.startsWith(subscription + '.');
}

/**
 * Bare names of the per-user personal topics. The WorkspaceHub always rejects
 * a subscribe to one of these (personal-topic isolation) — a client must use
 * the user-scoped form (`notification.<userId>`, `mail.<userId>`, …). Mirrors
 * `PERSONAL_TOPIC_PREFIXES` in the realtime-worker. Used client-side to skip a
 * doomed subscribe rather than letting the server reject it with a `forbidden`.
 */
const BARE_PERSONAL_TOPICS = new Set(['notification', 'mail', 'inbox', 'chat.user']);

export function isBarePersonalTopic(topic: string): boolean {
  return BARE_PERSONAL_TOPICS.has(topic);
}
