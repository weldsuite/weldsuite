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
  // Project-scoped tasks publish as `project_task` (not `task`). Invalidate
  // My Tasks (`['task']`) as well as project boards + the object panel so
  // cross-screen sync covers every task surface.
  project_task: inv(projectKeys.all, taskKeys.all, ['app-api', 'task-panel']),
  project_time_entry: inv(projectKeys.all),
  project_timesheet: inv(['timesheets'], projectKeys.all),
  project_label: inv(['app-api', 'task-panel', 'labels'], projectKeys.all),
  time_entry: { invalidate: [projectKeys.all] },
  // project_pipeline_stage — intentional omit (see intentional-omits.ts).

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
  // Runtime CRM publishers emit `person` / `company`. Catalog also keeps the
  // legacy `contact` / `customer` topics (agents/analytics); alias them to the
  // same people/companies caches so residual hub events still refresh UI.
  person: {
    invalidate: [personKeys.all],
    updateDetail: detailUpdater(personKeys.detail),
    remove: detailRemover(personKeys.detail),
  },
  contact: {
    invalidate: [personKeys.all],
    updateDetail: detailUpdater(personKeys.detail),
    remove: detailRemover(personKeys.detail),
  },
  company: {
    invalidate: [companyKeys.all],
    updateDetail: detailUpdater(companyKeys.detail),
    remove: detailRemover(companyKeys.detail),
  },
  customer: {
    invalidate: [companyKeys.all],
    updateDetail: detailUpdater(companyKeys.detail),
    remove: detailRemover(companyKeys.detail),
  },
  // Person↔company junction. Publishers emit contact_link created/deleted and
  // also person+company updated; invalidate both identity roots either way.
  contact_link: inv(personKeys.all, companyKeys.all),
  lead: { invalidate: [leadKeys.all] },
  opportunity: { invalidate: [opportunityKeys.all, pipelineKeys.all] },
  activity: inv(['crm', 'activities']),
  // WMS suppliers table publishes entityType `supplier`; CRM "suppliers" UI is
  // an isSupplier filter on people/companies (covered by those topics).
  supplier: inv(['weldstash', 'suppliers']),
  // Primary list pages use ['lists']; customer-detail picker uses ['crm','lists'].
  customer_list: inv(['lists'], ['crm', 'lists']),
  pipeline: inv(['crm', 'pipelines']),
  pipeline_stage: inv(['crm', 'pipeline-stages']),
  custom_field: inv(['settings', 'custom-fields'], ['settings', 'custom-fields-all']),
  object_template: inv(['object-templates']),
  enrich_field: inv(['enrich-fields']),
  sequence: inv(['sequences']),
  call: inv(['crm', 'voip-calls'], ['crm', 'call-intelligence']),
  transcription: inv(
    ['crm', 'voip-calls'],
    ['crm', 'call-recordings'],
    ['crm', 'call-intelligence'],
  ),
  meeting_bot_session: inv(['crm', 'call-intelligence', 'meeting-bot']),
  customer_status: inv(['weldcrm', 'customer-statuses']),
  // Shared topic name across CRM + WeldFlow analytics — invalidate both roots.
  analytics_report: inv(['crm', 'analytics'], ['projects', 'analytics']),
  analytics_chart: inv(['projects', 'analytics']),

  // =========================================================================
  // WeldBooks — Accounting
  // =========================================================================
  // Prefer targeted prefixes over bare ['accounting'] so WMS-style latency-
  // sensitive screens aren't forced to share an over-broad root.
  invoice: inv(
    ['accounting', 'invoices'],
    ['accounting', 'payments'],
    ['accounting', 'dashboard'],
    ['accounting', 'reports'],
  ),
  bill: inv(
    ['accounting', 'bills'],
    ['accounting', 'payments'],
    ['accounting', 'dashboard'],
    ['accounting', 'documents'],
  ),
  payment: inv(
    ['accounting', 'payments'],
    ['accounting', 'invoices'],
    ['accounting', 'bills'],
    ['accounting', 'dashboard'],
  ),
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
  // Phase 3 gaps — API/agent surfaces today; provisional kebab prefixes match
  // accountingKeys style until dedicated list hooks land.
  purchase_order: inv(['accounting', 'purchase-orders']),
  fiscal_period: inv(['accounting', 'fiscal-periods']),
  fx_rate: inv(['accounting', 'fx-rates']),

  // =========================================================================
  // WeldStash — WMS
  // =========================================================================
  warehouse: inv(['weldstash', 'warehouses'], ['weldstash', 'stock']),
  // Runtime inventory routes publish `inventory` (not `wms_inventory`). Keep
  // both keys so either emitter refreshes stock/movements.
  inventory: inv(['weldstash', 'stock'], ['weldstash', 'movements']),
  wms_inventory: inv(['weldstash', 'stock'], ['weldstash', 'movements']),
  // Shared `products` table: commerce + WMS UIs both listen. Catalog twin
  // `wms_product` covers connectors/future emitters.
  product: inv(
    ['weldcommerce', 'products'],
    ['weldstash', 'products'],
    ['weldstash', 'stock'],
  ),
  wms_product: inv(['weldstash', 'products'], ['weldstash', 'stock']),
  wms_adjustment: inv(['weldstash', 'stock'], ['weldstash', 'movements']),
  picklist: inv(['weldstash', 'pickLists'], ['weldstash', 'stock']),
  wms_inventory_movement: inv(['weldstash', 'movements'], ['weldstash', 'stock']),
  // Provisional — no dedicated platform list hooks yet (API/agents).
  picker: inv(['weldstash', 'pickers']),
  putaway: inv(['weldstash', 'putaway'], ['weldstash', 'stock']),
  warehouse_zone: inv(['weldstash', 'zones'], ['weldstash', 'warehouses']),
  wms_location: inv(
    ['weldstash', 'locations'],
    ['weldstash', 'warehouses'],
    ['weldstash', 'stock'],
  ),
  wms_cycle_count: inv(['weldstash', 'cycle-counts'], ['weldstash', 'stock']),
  wms_order: inv(['weldstash', 'orders']),
  wms_category: inv(['weldstash', 'categories'], ['weldstash', 'products']),

  // =========================================================================
  // WeldCommerce — Products, Orders, Fulfillment, Website builder (catalog)
  // =========================================================================
  // Real UI today: products / categories / orders via commerceKeys
  // (`['weldcommerce', …]` in use-commerce-queries.ts). Runtime order routes
  // publish `commerce_order`; connector ingest may emit legacy `order`.
  category: inv(['weldcommerce', 'categories'], ['weldcommerce', 'products']),
  commerce_order: inv(['weldcommerce', 'orders']),
  order: inv(['weldcommerce', 'orders']),
  // Commerce customers UI is people/companies filters; primary sync is
  // company/person. Alias covers any future commerce_customer emitters.
  commerce_customer: inv(['companies'], ['people']),
  // Provisional kebab prefixes — API (and/or catalog) ahead of list hooks.
  discount: inv(['weldcommerce', 'discounts']),
  website: inv(['weldcommerce', 'websites']),
  website_domain: inv(['weldcommerce', 'websites'], ['weldcommerce', 'website-domains']),
  // Builder pages/sections: dual-invalidate so future detail hooks under
  // website-pages / website-sections refresh without bare ['weldcommerce'].
  website_page: inv(['weldcommerce', 'websites'], ['weldcommerce', 'website-pages']),
  website_section: inv(
    ['weldcommerce', 'websites'],
    ['weldcommerce', 'website-sections'],
    ['weldcommerce', 'website-pages'],
  ),
  cart: inv(['weldcommerce', 'carts']),
  return: inv(['weldcommerce', 'returns']),
  return_reason: inv(['weldcommerce', 'return-reasons']),
  return_rule: inv(['weldcommerce', 'return-rules']),
  shipment: inv(['weldcommerce', 'shipments']),
  shipping_price: inv(['weldcommerce', 'shipping-prices']),
  shipping_rule: inv(['weldcommerce', 'shipping-rules']),

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
  // Phase 2 — remaining catalog types. `helpdesk_email` matches inline
  // queryKeys in welddesk email settings; ticket_note / sla /
  // satisfaction_survey reserve kebab prefixes consistent with helpdeskKeys
  // (no dedicated list hooks yet) and bump tickets/analytics where UI surfaces them.
  ticket_note: inv(['helpdesk', 'ticket-notes'], ['helpdesk', 'tickets']),
  sla: inv(['helpdesk', 'slas']),
  satisfaction_survey: inv(
    ['helpdesk', 'satisfaction-surveys'],
    ['helpdesk', 'analytics'],
  ),
  helpdesk_email: inv(['helpdesk', 'email']),

  // WeldDesk webchat — list + open conversation pane
  desk_conversation: {
    invalidate: [deskKeys.conversations()],
    updateDetail: detailUpdater(deskKeys.conversationDetail),
    remove: detailRemover(deskKeys.conversationDetail),
  },
  desk_message: {
    invalidate: [deskKeys.conversations()],
    updateDetail: (qc, _entityId, data) => {
      const conversationId = (data as { conversationId?: string } | null)?.conversationId;
      if (!conversationId) return;
      qc.invalidateQueries({ queryKey: deskKeys.conversationDetail(conversationId) as unknown as unknown[] });
    },
  },
  desk_widget: inv(['desk', 'widget']),

  // =========================================================================
  // WeldMail
  // (per-user inbox live-updates also flow through useMailRealtime's personal
  //  topic; these workspace entries cover shared-mailbox / cross-user cases.
  //  Inbound also dual-publishes hub email:created — keep mail:new for toasts.)
  // =========================================================================
  email: inv(['mail']),
  mail_account: inv(['mail', 'accounts']),
  mail_attachment: inv(['mail', 'attachments']),
  mail_domain: inv(['mail', 'domains']),
  mail_draft: inv(['mail', 'drafts']),
  mail_folder: inv(['mail']),
  mail_label: inv(['mail', 'labels']),
  mail_campaign: inv(['mail', 'campaigns']),
  mail_signature: inv(['mail', 'signatures']),
  email_rule: inv(['mail', 'rules']),
  email_template: inv(['mail', 'templates']),

  // =========================================================================
  // WeldMeet — Meetings & Calendar
  // =========================================================================
  meeting: { invalidate: [weldmeetKeys.all] },
  meeting_session: { invalidate: [weldmeetKeys.all] },
  meeting_message: inv(['meeting-chat']),
  // DB waitlist CRUD (portal / admin). Live admit UI is RealtimeKit
  // participants.waitlisted — provisional weldmeet root for catalog completeness.
  meeting_waitlist: inv(weldmeetKeys.all),
  calendar_event: { invalidate: [calendarKeys.all] },
  calendar: inv(['user-calendars'], ['calendar']),
  // Booking list hooks removed (W5b); keep calendar so event-side effects refresh.
  calendar_booking: inv(['calendar']),
  calendar_booking_page: inv(['booking-pages']),
  calendar_share: inv(['user-calendars']),

  // =========================================================================
  // Workspace — Notifications, Automation (WeldFlow workflows), Settings
  // =========================================================================
  notification: { invalidate: [notificationKeys.all] },
  // Parcel SMS/WhatsApp/webhook templates (API + portals); no platform list hooks yet.
  notification_template: inv(['parcel-notifications']),
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
  // WeldConnect › Connectors — connectorKeys.all in use-connector-queries.ts
  connector_connection: inv(['connectors']),

  // =========================================================================
  // WeldHost — Domains, DNS, VoIP
  // =========================================================================
  // hostKeys: domains / dashboard / nested dns under domains/:id/dns.
  // VoIP uses phoneNumberKeys + portingKeys (not under hostKeys).
  domain: inv(['host', 'domains'], ['host', 'dashboard']),
  domain_transfer: inv(['host']),
  dns_record: inv(['host']),
  dns_zone: inv(['host']),
  // No list hooks yet; domain detail shows emailForwardingEnabled flag.
  email_forward: inv(['host', 'email-forwards'], ['host', 'domains']),
  voip_phone_number: inv(['phone-numbers'], ['crm', 'voip-calls', 'phone-numbers']),
  voip_porting_order: inv(['porting']),

  // =========================================================================
  // Drive — Files & Folders (+ native rich-text docs)
  // =========================================================================
  file: inv(['drive']),
  folder: inv(['drive']),
  // Native doc content (`docs` table). Create also publishes `file`; list
  // refresh is drive-root. Open editor (useHtmlDoc) is local — not CRDT.
  doc: inv(['drive']),

  // =========================================================================
  // WeldKnow — Workspace knowledge base / wiki
  // =========================================================================
  knowledge_space: inv(knowledgeKeys.spaces(), knowledgeKeys.tree()),
  knowledge_page: {
    // Structural changes (created/deleted/moved/restored) all reshuffle the
    // sidebar tree and trash list; `updated` (title/icon/content) also needs
    // the tree invalidated since it carries title/icon for the sidebar rows.
    // `pages` prefix covers pageDetail + versions list queries.
    invalidate: [
      knowledgeKeys.tree(),
      knowledgeKeys.trash(),
      knowledgeKeys.favorites(),
      knowledgeKeys.pages(),
    ],
    updateDetail: detailUpdater(knowledgeKeys.pageDetail),
    remove: detailRemover(knowledgeKeys.pageDetail),
  },

  // =========================================================================
  // WeldSocial — socialKeys.all = ['social'] in use-social-queries.ts
  // =========================================================================
  social_account: inv(['social']),
  social_approval: inv(['social']),
  social_campaign: inv(['social']),
  social_media: inv(['social']),
  social_post: inv(['social']),
  social_settings: inv(['social']),
  social_team_member: inv(['social']),

  // =========================================================================
  // Parcels — no platform TanStack hooks yet (portals are out of scope).
  // Provisional ['parcel'] root for catalog completeness / future UI.
  // =========================================================================
  parcel: inv(['parcel']),
  parcel_box: inv(['parcel']),
  parcel_carrier: inv(['parcel']),
  parcel_order: inv(['parcel']),
  parcel_pickup: inv(['parcel']),
  parcel_wallet: inv(['parcel']),
  parcel_settings: inv(['parcel']),

  // =========================================================================
  // WeldAds — weldadsKeys.all in use-weldads-queries.ts
  // =========================================================================
  ad_platform_connection: inv(['weldads']),
  ad_account: inv(['weldads']),
  ad_campaign: inv(['weldads']),

  // =========================================================================
  // WeldHR — weldhrKeys.all in use-weldhr-queries.ts. Payloads carry ids
  // only, so every hr_* topic simply refetches the mounted WeldHR queries.
  // =========================================================================
  hr_employee: inv(['weldhr']),
  hr_client_assignment: inv(['weldhr']),
  hr_checklist: inv(['weldhr']),
  hr_attendance: inv(['weldhr']),
  hr_leave_request: inv(['weldhr']),
  hr_coaching_log: inv(['weldhr']),
  hr_evaluation: inv(['weldhr']),
  hr_kpi_value: inv(['weldhr']),
  hr_milestone: inv(['weldhr']),

  // =========================================================================
  // WeldData — welddataKeys.all in use-welddata-queries.ts
  // =========================================================================
  welddata_list: inv(['welddata']),
  welddata_lead: inv(['welddata']),
  welddata_column: inv(['welddata']),

  // =========================================================================
  // WeldApps — userAppsKeys + installedAppsKeys (install mutates both)
  // =========================================================================
  user_app: inv(['user-apps'], ['installed-apps']),
};
