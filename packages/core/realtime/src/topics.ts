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
 * Hub key for a personal (consumer) account.
 *
 * WorkspaceHub DOs are addressed by name, and workspace hubs use the Clerk org
 * id. Personal WeldMail users have no org, so they get their own hub named
 * `personal:<clerkUserId>` — a namespace no Clerk org id can collide with
 * (org ids never contain a colon). Inside that hub the same per-user topics
 * apply (`mail.<clerkUserId>`, `notification.<clerkUserId>`), so the existing
 * personal-topic isolation carries over unchanged.
 */
export const PERSONAL_HUB_PREFIX = 'personal:';

export function personalHubKey(clerkUserId: string): string {
  return `${PERSONAL_HUB_PREFIX}${clerkUserId}`;
}

export function isPersonalHubKey(hubKey: string): boolean {
  return hubKey.startsWith(PERSONAL_HUB_PREFIX);
}

/**
 * WeldHR workforce portal hubs: `hrportal:<clerkOrgId>`.
 *
 * Portal users (employees, client contacts) are not workspace members, so they
 * never join the workspace's own hub — they would see every catalog topic and
 * show up in presence. Their own hub carries only the id-only "something
 * changed" signals app-api publishes for them, on these topics:
 *
 *   hrportal.workspace                 branding / settings / leave types changed
 *   hrportal.employee.<employeeId>     one employee's own records changed
 *   hrportal.client.<companyId>        data a client account can see changed
 *
 * Each connection may subscribe to `hrportal.workspace` plus exactly one of
 * the principal topics (enforced by the realtime worker's allow list).
 */
export const HR_PORTAL_HUB_PREFIX = 'hrportal:';

export function hrPortalHubKey(clerkOrgId: string): string {
  return `${HR_PORTAL_HUB_PREFIX}${clerkOrgId}`;
}

export function isHrPortalHubKey(hubKey: string): boolean {
  return hubKey.startsWith(HR_PORTAL_HUB_PREFIX);
}

export const hrPortalTopics = {
  workspace: 'hrportal.workspace',
  employee: (employeeId: string) => `hrportal.employee.${employeeId}`,
  client: (companyId: string) => `hrportal.client.${companyId}`,
} as const;

/**
 * Single-use connect ticket for a portal WebSocket. app-api writes it to the
 * shared WORKSPACE_CACHE KV under `hrPortalTicketKvKey(sha256(ticket))` after
 * checking the portal session; the realtime worker reads and deletes it on
 * `/ws/hr-portal`. Only the hash is ever a key, so a KV listing leaks nothing
 * usable.
 */
export interface HrPortalRealtimeTicket {
  /** Clerk org id of the workspace — the hub is `hrPortalHubKey(orgId)`. */
  orgId: string;
  /** hr_portal_access row the session belongs to; becomes the connection's user id. */
  accessId: string;
  kind: 'employee' | 'client';
  employeeId: string | null;
  companyId: string | null;
}

export function hrPortalTicketKvKey(ticketHash: string): string {
  return `hrportal:rt:${ticketHash}`;
}

/** The only topics a portal connection may subscribe to. */
export function hrPortalAllowedTopics(ticket: HrPortalRealtimeTicket): string[] {
  const own =
    ticket.kind === 'employee'
      ? ticket.employeeId
        ? hrPortalTopics.employee(ticket.employeeId)
        : null
      : ticket.companyId
        ? hrPortalTopics.client(ticket.companyId)
        : null;
  return own ? [hrPortalTopics.workspace, own] : [hrPortalTopics.workspace];
}

/** Hubs with no workspace members behind them — presence stays in the DO, never in a tenant DB. */
export function isMemberlessHubKey(hubKey: string): boolean {
  return isPersonalHubKey(hubKey) || isHrPortalHubKey(hubKey);
}

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
