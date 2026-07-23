// @weldsuite/db - Database utilities
// Re-exports all database connection and utility functions

// Core database connection
export { db, type DB } from './db';

// Master database connection
export { masterDb, type MasterDB } from './master';

// Workers database factories (for Cloudflare Workers with Hyperdrive)
export {
  createMasterDbFromHyperdrive,
  type MasterDb as WorkersMasterDb,
} from './db-workers';

// Tenant database routing and management
export {
  type TenantInfo,
  getTenantInfo,
  getTenantDb,
  getTenantDbByWorkspaceId,
  type TenantDb,
} from './tenant';

// Scoped database utilities (workspace-filtered queries)
export { createScopedDb, type ScopedDb, type ScopedDbOptions } from './scoped';

// Auth-aware database utilities (platform-specific, requires Clerk)
export {
  getUserId,
  getUserIdOptional,
  getScopedDb,
  getScopedDbOptional,
  getScopedDbForWorkspace,
  getWorkspaceId,
  getTenant,
  autoAcceptPendingInvites,
} from './auth';

// Admin database operations (platform-specific, requires Clerk)
export {
  getMasterDb,
  getSharedDb,
  requireAdmin,
  isAdmin,
  adminWorkspaces,
  adminPlans,
  adminDomainPricing,
  adminSettings,
  adminUsers,
  adminEnterpriseInquiries,
  adminFeatureRequests,
  adminAppCatalog,
  adminAppScreenshots,
} from './admin';

// Mail contact upsert helpers (used by mail-inbound-worker, api-worker,
// core-api, and the trigger.dev backfill job).
export {
  upsertMailContact,
  upsertMailContactsBatch,
  collectMailMessageAddresses,
  generateInitialsAvatarSvg,
  buildContactAvatarPath,
  type MailContactAddress,
  type MailContactUpsertResult,
  type IdGenerator,
} from './mail-contacts';

// Person resolver — canonical "find or create a Person by email" used by all
// workers that need to attach an incoming email to a `people` row.
// Supersedes the per-worker copies that used to live in
// apps/core-api/src/lib/participant-resolver.ts and inside individual handlers.
export {
  findOrCreatePersonByEmail,
  findOrCreatePeopleByEmailBatch,
  type ResolvePersonInput,
  type ResolvedPerson,
} from './person-resolver';

// Custom field VALUES service — typed one-cell-per-value store backing the
// `custom_field_values` table. Shared by app-api, helpdesk-widget-api,
// helpdesk-workflow-worker and external-api (each injects its own generateId).
export {
  getDefinitionsForEntityType,
  getDefinitionsForTicket,
  ensureCustomFieldDefinition,
  getValuesForEntities,
  getValuesForEntity,
  hydrateCustomFields,
  hydrateCustomFieldsOne,
  setValues,
  deleteValuesForEntity,
  syncValuesForEntity,
  CustomFieldValidationError,
  type CustomFieldMap,
  type CustomFieldDefinitionRow,
} from './custom-field-values';

// Ticket-type dynamic-form fields → custom_field_definitions sync (Pile B).
export { syncTicketTypeDefinitions } from './custom-field-ticket-types';
