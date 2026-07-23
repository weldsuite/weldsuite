/**
 * Platform EntitySyncMap — maps entity topics from @weldsuite/realtime
 * to TanStack Query cache operations.
 *
 * Used by useRealtimeSync() in the root layout to keep query caches
 * in sync when other users mutate data on another browser/device.
 *
 * apps/workers/app-api publishes EVERY entity in the events catalog
 * (packages/core/entity-events/src/events/*) to the workspace Durable Object.
 * A topic with no entry here is received over the WebSocket and silently
 * dropped, so its pages never live-update. This map therefore aims to cover
 * the full catalog surface that has a real platform page/query.
 *
 * Keys are inlined here (rather than imported from the per-module query hook
 * files) so this sync map — which is mounted at app shell startup — doesn't
 * drag the entire hooks/queries/* tree into the main bundle. The shape must
 * stay in lockstep with the canonical key definitions in
 * apps/web/platform/hooks/queries/use-*-queries.ts and
 * apps/web/platform/components/objects/{company,person,task}/use-*-data.ts.
 *
 * Most entries are invalidate-only: invalidating a query key refetches any
 * ACTIVE (mounted) query under that prefix — including open detail pages —
 * which is sufficient for cross-browser sync. The richer updateDetail/remove
 * optimisations are kept only on the hot entities that already had them.
 */

import type { EntitySyncMap, EntitySyncConfig, QueryClientLike } from '@weldsuite/realtime/react';

const projectKeys = {
  all: ['projects'] as const,
  lists: () => [...projectKeys.all, 'list'] as const,
  details: () => [...projectKeys.all, 'detail'] as const,
  detail: (id: string) => [...projectKeys.details(), id] as const,
};

const taskKeys = {
  all: ['task'] as const,
  // Real key is taskKeys.taskDetail(id) = ['task','tasks','detail',id] (it
  // spreads taskKeys.tasks() = ['task','tasks']). The previous ['task','detail',id]
  // form targeted a non-existent cache slot, so updateDetail/remove silently
  // no-op'd on every task update/delete.
  taskDetail: (id: string) => ['task', 'tasks', 'detail', id] as const,
};

const companyKeys = {
  all: ['companies'] as const,
  detail: (id: string) => [...companyKeys.all, 'detail', id] as const,
};

const personKeys = {
  all: ['people'] as const,
  detail: (id: string) => [...personKeys.all, 'detail', id] as const,
};

const leadKeys = { all: ['crm', 'leads'] as const };
const opportunityKeys = { all: ['crm', 'opportunities'] as const };
const pipelineKeys = { all: ['crm', 'pipelines'] as const };
const accountingKeys = { all: ['accounting'] as const };
const helpdeskKeys = { all: ['helpdesk'] as const };
const notificationKeys = { all: ['notifications'] as const };
const weldmeetKeys = { all: ['weldmeet'] as const };
const calendarKeys = { all: ['calendar'] as const };

// WeldKnow — mirrors knowledgeKeys in hooks/queries/use-knowledge-queries.ts.
// Tree/trash/favorites are invalidate-only (list-shaped); page detail gets
// the richer updateDetail/remove treatment since it's a hot single-record view.
const knowledgeKeys = {
  all: ['knowledge'] as const,
  spaces: () => [...knowledgeKeys.all, 'spaces'] as const,
  tree: () => [...knowledgeKeys.all, 'tree'] as const,
  pages: () => [...knowledgeKeys.all, 'pages'] as const,
  pageDetail: (id: string) => [...knowledgeKeys.pages(), 'detail', id] as const,
  trash: () => [...knowledgeKeys.all, 'trash'] as const,
  favorites: () => [...knowledgeKeys.all, 'favorites'] as const,
};

// WeldDesk v2 (Intercom-model inbox) — mirrors deskKeys in
// hooks/queries/use-desk-queries.ts. Conversation detail gets the richer
// updateDetail/remove treatment (hot single-record view, open in the
// conversation pane); everything else invalidate-only.
const deskKeys = {
  all: ['desk'] as const,
  conversations: () => [...deskKeys.all, 'conversations'] as const,
  conversationDetail: (id: string) => [...deskKeys.conversations(), 'detail', id] as const,
  teams: () => [...deskKeys.all, 'teams'] as const,
  views: () => [...deskKeys.all, 'views'] as const,
  macros: () => [...deskKeys.all, 'macros'] as const,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates an updateDetail callback for the standard API response shape:
 * `{ success: boolean; data: { ...entity } }`
 *
 * When the incoming payload has a `version` field, we refuse to overwrite a
 * cached row with a newer version — this happens when an event arrives out
 * of order or after the mutation's onSuccess already wrote a newer row.
 */
function detailUpdater(keyFn: (id: string) => readonly unknown[]) {
  return (qc: QueryClientLike, id: string, data: unknown) => {
    qc.setQueryData(keyFn(id), (old: unknown) => {
      if (!old || typeof old !== 'object') return old;
      const entity = data as Record<string, unknown>;
      const incomingVersion = typeof entity.version === 'number' ? entity.version : null;

      const merge = (target: Record<string, unknown>) => {
        if (incomingVersion !== null && typeof target.version === 'number' && target.version >= incomingVersion) {
          return target;
        }
        return { ...target, ...entity };
      };

      if ('data' in old) {
        const oldData = (old as { data: Record<string, unknown> }).data;
        const nextData = merge(oldData);
        if (nextData === oldData) return old;
        return { ...(old as Record<string, unknown>), data: nextData };
      }
      return merge(old as Record<string, unknown>);
    });
  };
}

function detailRemover(keyFn: (id: string) => readonly unknown[]) {
  return (qc: QueryClientLike, id: string) => {
    qc.removeQueries({ queryKey: keyFn(id) as unknown[] });
  };
}

/** Invalidate-only entry. Each argument is a query-key prefix. */
const inv = (...invalidate: readonly (readonly unknown[])[]): EntitySyncConfig => ({ invalidate });

// ---------------------------------------------------------------------------
// Sync Map
// ---------------------------------------------------------------------------

export const platformSyncMap: EntitySyncMap = {
  // =========================================================================
  // WeldFlow — Projects & Tasks
  // =========================================================================
  project: {
    invalidate: [projectKeys.all],
    updateDetail: detailUpdater(projectKeys.detail),
    remove: detailRemover(projectKeys.detail),
  },
  project_member: { invalidate: [projectKeys.all] },
  project_document: { invalidate: [projectKeys.all] },
  project_file: { invalidate: [projectKeys.all] },
  project_goal: { invalidate: [projectKeys.all] },
  project_message: { invalidate: [projectKeys.all] },
  project_whiteboard: { invalidate: [projectKeys.all] },
  project_milestone: inv(projectKeys.all), // replaces the stale 'milestone' topic
  project_sprint: inv(projectKeys.all),
  project_task: inv(projectKeys.all, ['app-api', 'task-panel']),
  project_time_entry: inv(projectKeys.all),
  project_timesheet: inv(['timesheets'], projectKeys.all),
  project_label: inv(['app-api', 'task-panel', 'labels'], projectKeys.all),
  time_entry: { invalidate: [projectKeys.all] },
  // NOTE: project_pipeline_stage intentionally omitted — the WeldFlow kanban
  // stage page fetches imperatively (no useQuery cache slot), and the only
  // existing stage key belongs to CRM. Wire after that page adopts useQuery.

  task: {
    invalidate: [taskKeys.all],
    updateDetail: detailUpdater(taskKeys.taskDetail),
    remove: detailRemover(taskKeys.taskDetail),
  },
  personal_task: { invalidate: [taskKeys.all] },
  task_comment: inv(['app-api', 'task-panel', 'comments']),
  task_project: inv(['task', 'projects']),
  task_tag: inv(['task', 'tags']),

  // =========================================================================
  // WeldCRM
  // =========================================================================
  person: {
    invalidate: [personKeys.all],
    updateDetail: detailUpdater(personKeys.detail),
    remove: detailRemover(personKeys.detail),
  },
  company: {
    invalidate: [companyKeys.all],
    updateDetail: detailUpdater(companyKeys.detail),
    remove: detailRemover(companyKeys.detail),
  },
  lead: { invalidate: [leadKeys.all] },
  opportunity: { invalidate: [opportunityKeys.all, pipelineKeys.all] },
  activity: inv(['crm', 'activities']),
  supplier: inv(['crm', 'suppliers']),
  customer_list: inv(['crm', 'lists']),
  pipeline: inv(['crm', 'pipelines']),
  pipeline_stage: inv(['crm', 'pipeline-stages']),
  custom_field: inv(['settings', 'custom-fields'], ['settings', 'custom-fields-all']),
  object_template: inv(['object-templates']),
  enrich_field: inv(['enrich-fields']),
  sequence: inv(['sequences']),
  call: inv(['crm', 'voip-calls'], ['crm', 'call-intelligence']),
  meeting_bot_session: inv(['crm', 'call-intelligence', 'meeting-bot']),
  customer_status: inv(['weldcrm', 'customer-statuses']),
  // Shared topic name across CRM + WeldFlow analytics — invalidate both roots.
  analytics_report: inv(['crm', 'analytics'], ['projects', 'analytics']),
  analytics_chart: inv(['projects', 'analytics']),

  // =========================================================================
  // WeldBooks — Accounting
  // =========================================================================
  invoice: { invalidate: [accountingKeys.all] },
  bill: { invalidate: [accountingKeys.all] },
  payment: { invalidate: [accountingKeys.all] },
  account: inv(['accounting', 'accounts']),
  accounting_contact: inv(['accounting', 'customers']),
  accounting_document: inv(['accounting', 'documents']),
  accounting_settings: inv(['accounting', 'settings']),
  bank_account: inv(['accounting', 'bank-accounts']),
  bank_transaction: inv(['accounting', 'bank-transactions']),
  // Posting a journal entry changes account balances → invalidate both.
  journal_entry: inv(['accounting', 'journal-entries'], ['accounting', 'accounts']),
  reconciliation_rule: inv(['accounting', 'reconciliation-rules']),
  recurring_invoice: inv(['accounting', 'recurring']),
  tax_rate: inv(['accounting', 'tax-rates']),
  vat_return: inv(['accounting', 'vat-returns']),
  accounting_entity: inv(['accounting', 'entities']),

  // =========================================================================
  // WeldStash — WMS
  // =========================================================================
  warehouse: inv(['weldstash', 'warehouses'], ['weldstash', 'stock']),
  wms_inventory: inv(['weldstash', 'stock']),
  wms_product: inv(['weldstash', 'products'], ['weldstash', 'stock']),
  wms_adjustment: inv(['weldstash', 'stock']),

  // =========================================================================
  // WeldDesk — Helpdesk
  // =========================================================================
  ticket: { invalidate: [helpdeskKeys.all] },
  helpdesk_ticket: { invalidate: [helpdeskKeys.all] },
  conversation: inv(['helpdesk', 'conversations']),
  helpdesk_conversation: { invalidate: [helpdeskKeys.all] },
  helpdesk_conversation_message: { invalidate: [helpdeskKeys.all] },
  helpdesk_message: inv(['helpdesk', 'tickets']),
  helpdesk_agent: inv(['helpdesk', 'agents']),
  helpdesk_article: inv(['helpdesk', 'articles'], ['helpdesk', 'help-articles']),
  helpdesk_contact: inv(['helpdesk', 'contacts']),
  helpdesk_folder: inv(['helpdesk', 'folders'], ['helpdesk', 'help-folders']),
  helpdesk_news: inv(['helpdesk', 'news']),
  helpdesk_settings: inv(['helpdesk', 'settings']),
  helpdesk_ticket_type: inv(['helpdesk', 'ticket-types']),
  helpdesk_widget: inv(['helpdesk', 'widgets'], ['helpdesk', 'widget', 'settings']),
  helpdesk_workflow: inv(['helpdesk-automation']),
  department: inv(['helpdesk', 'departments'], ['helpdesk', 'department-inbox-counts']),
  canned_response: inv(['helpdesk', 'canned-responses']),
  helpdesk_announcement: inv(['helpdesk', 'announcements']),
  helpdesk_faq: inv(['helpdesk', 'faqs']),
  helpdesk_feedback: inv(['helpdesk', 'feedback']),
  helpdesk_review: inv(['helpdesk', 'reviews']),
  helpdesk_analytics_report: inv(['helpdesk', 'analytics', 'reports']),
  helpcenter_settings: inv(['helpdesk', 'helpcenter']),

  // =========================================================================
  // WeldDesk v2 — Intercom-model inbox (apps/web/platform/app/welddesk/inbox2)
  // desk_conversation covers both the list rows (any field changed —
  // assignment/state/tags/etc.) and the open conversation pane's header;
  // desk_conversation_part covers the parts timeline appended to an open
  // conversation. Both invalidate the list broadly since sort/filter
  // membership (state, assignee, waitingSince) can change on any part-append.
  // =========================================================================
  desk_conversation: {
    invalidate: [deskKeys.conversations()],
    updateDetail: detailUpdater(deskKeys.conversationDetail),
    remove: detailRemover(deskKeys.conversationDetail),
  },
  desk_conversation_part: {
    invalidate: [deskKeys.conversations()],
    // Parts are appended to the detail query's `parts` array (not a
    // top-level field), so a simple field-merge can't apply them here. The
    // published part payload carries `conversationId` (see
    // publishEntityEvent calls in apps/workers/app-api/src/routes/desk-conversations)
    // — invalidate that conversation's detail query so the open pane refetches
    // the fresh parts timeline. `entityId` itself is the part's own id, not
    // useful as a query key.
    updateDetail: (qc, _entityId, data) => {
      const conversationId = (data as { conversationId?: string } | null)?.conversationId;
      if (!conversationId) return;
      qc.invalidateQueries({ queryKey: deskKeys.conversationDetail(conversationId) as unknown as unknown[] });
    },
  },
  desk_team: inv(deskKeys.teams()),
  desk_view: inv(deskKeys.views()),
  desk_macro: inv(deskKeys.macros()),

  // =========================================================================
  // WeldMail
  // (per-user inbox live-updates also flow through useMailRealtime's personal
  //  topic; these workspace entries cover shared-mailbox / cross-user cases)
  // =========================================================================
  email: inv(['mail']),
  mail_account: inv(['mail', 'accounts']),
  mail_attachment: inv(['mail', 'attachments']),
  mail_domain: inv(['mail', 'domains']),
  mail_draft: inv(['mail', 'drafts']),
  mail_folder: inv(['mail']),
  mail_label: inv(['mail', 'labels']),

  // =========================================================================
  // WeldMeet — Meetings & Calendar
  // =========================================================================
  meeting: { invalidate: [weldmeetKeys.all] },
  meeting_session: { invalidate: [weldmeetKeys.all] },
  meeting_message: inv(['meeting-chat']),
  calendar_event: { invalidate: [calendarKeys.all] },
  calendar: inv(['user-calendars'], ['calendar']),
  calendar_booking: inv(['bookings'], ['calendar']),
  calendar_booking_page: inv(['booking-pages']),
  calendar_share: inv(['user-calendars']),

  // =========================================================================
  // Workspace — Notifications, Automation (WeldFlow workflows), Settings
  // =========================================================================
  notification: { invalidate: [notificationKeys.all] },
  digest_settings: inv(['task-digest', 'settings']),
  workspace_settings: inv(['settings', 'workspace']),
  workflow: inv(
    ['automation', 'workflows'],
    ['automation', 'workflow-stats'],
    ['automation', 'workflows-chaining'],
  ),
  workflow_execution: inv(['automation', 'executions'], ['automation', 'dashboard']),
  workflow_integration: inv(['automation', 'integrations']),
  workflow_schedule: inv(['automation', 'schedules']),
  workflow_template: inv(['automation', 'templates'], ['automation', 'template-categories']),
  workflow_trigger: inv(['automation', 'triggers']),
  workflow_variable: inv(['automation', 'variables']),
  workflow_webhook: inv(['automation', 'webhooks']),

  // =========================================================================
  // WeldHost — Domains, DNS, VoIP
  // =========================================================================
  domain: inv(['host', 'domains'], ['host', 'dashboard']),
  domain_transfer: inv(['host']),
  dns_record: inv(['host']),
  dns_zone: inv(['host']),
  voip_phone_number: inv(['phone-numbers'], ['crm', 'voip-calls', 'phone-numbers']),
  voip_porting_order: inv(['porting']),

  // =========================================================================
  // Drive — Files & Folders
  // =========================================================================
  file: inv(['drive']),
  folder: inv(['drive']),

  // =========================================================================
  // WeldKnow — Workspace knowledge base / wiki
  // =========================================================================
  knowledge_space: inv(knowledgeKeys.spaces(), knowledgeKeys.tree()),
  knowledge_page: {
    // Structural changes (created/deleted/moved/restored) all reshuffle the
    // sidebar tree and trash list; `updated` (title/icon/content) also needs
    // the tree invalidated since it carries title/icon for the sidebar rows.
    invalidate: [knowledgeKeys.tree(), knowledgeKeys.trash(), knowledgeKeys.favorites()],
    updateDetail: detailUpdater(knowledgeKeys.pageDetail),
    remove: detailRemover(knowledgeKeys.pageDetail),
  },
};
