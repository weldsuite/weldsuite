// Tenant database schemas (shared + dedicated)

// Projects module
export * from './projects';
export * from './tasks';
export * from './time-entries';
export * from './active-timers';
export * from './project-members';
export * from './milestones';
export * from './project-files';
export * from './project-messages';
export * from './sprints';
export * from './project-whiteboards';
export * from './project-documents';
export * from './project-goals';
export * from './project-pipeline-stages';
export * from './project-labels';
export * from './task-import-jobs';
export * from './task-number-sequences';

// Personal Task Management module (personal-tasks removed — use unified tasks table)
export * from './task-projects';
export * from './task-tags';
export * from './task-comments';

// Workflow Automation module
export * from './workflows';
export * from './workflow-executions';
export * from './workflow-execution-steps';
export * from './workflow-triggers';
export * from './workflow-schedules';
export * from './workflow-webhooks';
export * from './workflow-variables';
export * from './workflow-integrations';
export * from './workflow-templates';
export * from './workflow-error-logs';

// Storage
export * from './pending-uploads';
export * from './files';
export * from './folders';
export * from './sheets';
export * from './docs';
export * from './document-versions';
export * from './whiteboards';

// Unified Credits System — moved to master.ts (centralized in master DB)

// Shared entities (CRM, Commerce, WMS, etc.)
// Identity layer — Companies + People + employment junction
export * from './companies';
export * from './people';
export * from './person-companies';
// Counterparty wrapper layer
export * from './parties';
// Lists — single unified surface (replaces the legacy customer_lists +
// customer_list_members + contact_list_members + contact_customers +
// contact_suppliers + contact_links + customer_import_jobs tables).
export * from './lists';
export * from './welddata';
export * from './contact-external-identities';
export * from './products';
export * from './product-variants';
export * from './categories';
export * from './orders';
export * from './discounts';
export * from './product-connections';

// CRM module
export * from './crm-pipelines';
export * from './crm-pipeline-stages';
export * from './crm-leads';
export * from './crm-opportunities';
export * from './crm-customer-statuses';
export * from './object-templates';
export * from './crm-activities';
export * from './crm-transcriptions';
export * from './crm-quotes';
export * from './sequence-enrollments';
export * from './meeting-bot-sessions';
export * from './voip-calls';
export * from './voip-phone-numbers';
export * from './voip-porting-orders';
export * from './enrichment-logs';
export * from './enrich-field-definitions';
export * from './enrich-field-results';

// GitHub integration
export * from './github-connections';
export * from './github-repo-links';
export * from './github-project-links';
export * from './github-issue-sync-map';

// Sync logs (generic)
export * from './sync-logs';

// Integration connections (generic CRM/external provider)
export * from './integration-connections';
export * from './integration-entity-mappings';
export * from './integration-field-mappings';
export * from './integration-sync-conflicts';

// Host module
export * from './host-domains';
export * from './host-dns-zones';
export * from './host-dns-records';
export * from './host-email-forwards';
export * from './host-domain-transfers';

// Mail module
export * from './mail-accounts';
export * from './mail-domains';
export * from './mail-folders';
export * from './mail-messages';
export * from './mail-attachments';
export * from './mail-drafts';
export * from './mail-templates';
export * from './mail-campaigns';
export * from './mail-rules';
export * from './mail-signatures';
export * from './mail-labels';

// Helpdesk module
export * from './helpdesk-agents';
export * from './helpdesk-departments';
export * from './helpdesk-conversations';
export * from './helpdesk-conversation-messages';
export * from './helpdesk-conversation-events';
export * from './helpdesk-tickets'; // deprecated — use helpdeskConversations with isTicket=true
export * from './helpdesk-ticket-types';
export * from './helpdesk-ticket-messages'; // deprecated — use helpdeskConversationMessages
export * from './helpdesk-ticket-notes'; // deprecated — use helpdeskConversationEvents with note.added
export * from './welddesk-blocks';
export * from './helpdesk-article-folders';
export * from './helpdesk-articles';
export * from './knowledge-spaces';
export * from './knowledge-pages';
export * from './knowledge-page-versions';
export * from './knowledge-favorites';
export * from './helpdesk-faqs';
export * from './helpdesk-slas';
export * from './helpdesk-canned-responses';
export * from './helpdesk-announcements';
export * from './helpdesk-changelog';
export * from './helpdesk-news';
export * from './helpdesk-feedback';
export * from './helpdesk-reviews';
export * from './helpdesk-satisfaction-surveys';
export * from './helpdesk-settings';
export * from './helpdesk-workflows';
export * from './helpdesk-workflow-types';
export * from './helpdesk-workflow-executions';
// Removed: helpdesk-workflow-execution-steps, helpdesk-workflow-error-logs, helpdesk-workflow-variables
// Tables still exist in DB but are no longer used by the simplified workflow engine.
export * from './helpdesk-widget-settings';
export * from './helpdesk-helpcenter-settings';
export * from './helpdesk-helpcenter-domains';
export * from './helpdesk-channel-integrations';
export * from './helpdesk-analytics-reports';
export * from './helpdesk-analytics-charts';
export * from './helpdesk-analytics-views';

// WeldDesk v2 — Intercom-model rebuild (desk_* tables). The legacy
// helpdesk-* exports above are being replaced phase-by-phase; see
// .claude/welddesk-intercom-plan.md.
export * from './desk-conversations';
export * from './desk-conversation-parts';
export * from './desk-conversation-attributes';
export * from './desk-linked-objects';
export * from './desk-ticket-types';
export * from './desk-teams';
export * from './desk-views';
export * from './desk-macros';
export * from './desk-slas';
export * from './desk-office-hours';
export * from './desk-workflows';
export * from './desk-ai';
export * from './desk-news';
export * from './desk-widget-settings';

// Generic analytics (shared across apps)
export * from './analytics-reports';
export * from './analytics-charts';

// CRM analytics views
export * from './crm-analytics-views';

// Projects analytics views
export * from './projects-analytics-views';

// Parcel/Shipping module
export * from './carriers';
export * from './carrier-services';
export * from './boxes';
export * from './parcels';
export * from './shipments';
export * from './tracking-events';
export * from './pickups';
export * from './returns';
export * from './return-reasons';
export * from './return-rules';
export * from './shipping-rules';
export * from './shipping-prices';
export * from './notification-templates';
export * from './wallet';

// WMS / Inventory module
export * from './warehouses';
export * from './warehouse-zones';
export * from './warehouse-locations';
export * from './inventory';
export * from './stock-adjustments';
export * from './suppliers';
export * from './purchase-orders';
export * from './purchase-order-items';
export * from './pick-lists';
export * from './pick-list-items';
export * from './cycle-counts';
export * from './inventory-movements';
export * from './warehouse-workers';
export * from './activity-logs';

// Custom field definitions
export * from './custom-field-definitions';
export * from './custom-field-values';

// System settings (key-value configuration)
export * from './system-settings';

// App & User settings
export * from './user-app-assignments';
export * from './workspace-installed-apps';
// WeldApps (user-created apps) — tenant-side generic app storage
export * from './user-app-data';
export * from './user-preferences';
export * from './workspace-settings';
export * from './grid-views';
export * from './workspace-members';
export * from './member-notes';
export * from './access-requests';
// workspace-usage — moved to master.ts (centralized in master DB)
export * from './roles';
export * from './api-keys';
export * from './workspace-api-keys';
export * from './external-webhooks';

// WeldAgent — personal AI assistant conversations + messages (per-user chat history)
export * from './weldagent-conversations';
export * from './weldagent-messages';

// Mobile/Notifications
export * from './device-tokens';
export * from './notifications';
export * from './notification-preferences';
export * from './task-digest-settings';

// Social Media Manager module
export * from './social-accounts';
export * from './social-posts';
export * from './social-media';
export * from './social-analytics';
export * from './social-team-members';
export * from './social-approvals';
export * from './social-campaigns';

// Audit Logs (generic, cross-module)
export * from './audit-logs';

// Accounting module (shared database model — no prefix)
export * from './accounting-entities';
export * from './accounting-entity-sequences';
export * from './accounting-fx-rates';
export * from './accounting-settings';
export * from './accounting-fiscal-periods';
export * from './accounting-accounts';
export * from './accounting-tax-rates';
export * from './accounting-invoices';
export * from './accounting-bills';
export * from './accounting-journal-entries';
export * from './accounting-bank-accounts';
export * from './accounting-bank-transactions';
export * from './accounting-bank-import-batches';
export * from './accounting-reconciliation-rules';
export * from './accounting-vat-returns';
export * from './accounting-documents';
export * from './accounting-recurring-invoices';
export * from './accounting-payments';
export * from './accounting-audit-log';
export * from './accounting-contacts';
export * from './accounting-vies-checks';
export * from './accounting-icp-declarations';

// Calendar module
export * from './calendars';
export * from './calendar-shares';
export * from './calendar-events';
export * from './calendar-booking-pages';
export * from './calendar-bookings';

// WeldChat module (internal team chat)
export * from './chat-channels';
export * from './chat-channel-members';
export * from './chat-channel-role-links';
export * from './chat-messages';
export * from './chat-drafts';
export * from './chat-bookmarks';
export * from './chat-user-status';
export * from './chat-calls';
export * from './chat-reminders';
export * from './chat-message-reads';
export * from './chat-sections';

// WeldMeet module (meetings & video conferencing)
export * from './meetings';
export * from './meeting-sessions';
export * from './meeting-messages';
export * from './meeting-session-waitlist';

// Support channel (enterprise direct support chat)
export * from './support-channels';
export * from './support-channel-members';
export * from './support-messages';

// ---------------------------------------------------------------------------
// Duplicate-type disambiguation (TS2308).
//
// Several schema files independently declare the SAME structural type
// (`Money` is identical in seven shipping/wallet files; `Address` shows up
// in both parcels + pickups, etc.). When the barrel does `export *` from
// every file, those duplicates cause TS2308 "already exported" errors.
// The fix is to pick ONE canonical source per name and re-export it
// explicitly here. Consumers importing from `@weldsuite/db/schema` get a
// single, unambiguous symbol; the in-file duplicates remain for the
// schemas' own internal use without polluting the barrel.
//
// If you need to import any of these names, do so via the barrel
// (`@weldsuite/db/schema`) — direct imports from the source files keep
// working too.
// ---------------------------------------------------------------------------

export type { TriggerCategory } from './workflows';
export type { Money, WeightUnit } from './boxes';
export type { Address } from './parcels';
export type { TimeWindow } from './shipments';
export type { DayHours, AgentStatus } from './helpdesk-agents';
export type {
  SLAStatus,
  TicketChannel,
  TicketPriority,
  TicketSeverity,
  TicketType,
} from './helpdesk-conversations';
export type {
  MessageAttachment,
  MessageStatus,
  MessageType,
} from './helpdesk-conversation-messages';
export type {
  BusinessHours,
  EscalationRule,
} from './helpdesk-departments';
export type {
  ChartLayout,
  ChartType,
  EntityType,
} from './helpdesk-analytics-charts';
export type { HelpdeskEntityType } from './helpdesk-workflow-types';
export type { RuleAction, RuleCondition } from './return-rules';

// Note: Master database schemas are in ./master.ts
// Import them separately: import * as masterSchema from './schema/master'
