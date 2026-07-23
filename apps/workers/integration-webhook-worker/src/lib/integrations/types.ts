import type { NewCompany, NewPerson } from '@weldsuite/db/schema';

/**
 * External record fetched from a provider's API.
 */
export interface ExternalRecord {
  id: string;
  type: string; // 'person' | 'company'
  data: Record<string, unknown>;
  raw: unknown;
}

/**
 * Note fetched from a provider's API.
 */
export interface ExternalNote {
  id: string;
  parentObject: string;  // 'people' | 'companies'
  parentRecordId: string;
  title: string;
  content: string;       // plaintext or markdown
  createdAt: string;
  raw: unknown;
}

/**
 * Task fetched from a provider's API.
 */
export interface ExternalTask {
  id: string;
  content: string;
  isCompleted: boolean;
  deadlineAt: string | null;
  linkedRecords: Array<{ targetObject: string; targetRecordId: string }>;
  assignees: Array<{ referencedActorType: string; referencedActorId: string }>;
  createdAt: string;
  raw: unknown;
}

/**
 * List fetched from a provider's API.
 */
export interface ExternalList {
  listId: string;
  name: string;
  apiSlug: string;
  parentObject: string;
}

/**
 * List entry fetched from a provider's API.
 */
export interface ExternalListEntry {
  entryId: string;
  listId: string;
  parentRecordId: string;
  parentObject: string;
  entryValues: Record<string, unknown>;
  raw: unknown;
}

/**
 * Parsed webhook event from any provider.
 */
export interface ParsedWebhookEvent {
  eventType:
    | 'record.created' | 'record.updated' | 'record.deleted' | 'record.merged'
    | 'note.created' | 'note.updated' | 'note.deleted'
    | 'task.created' | 'task.updated' | 'task.deleted'
    | 'list-entry.created' | 'list-entry.updated' | 'list-entry.deleted';
  objectId: string;          // Provider's internal object UUID (for record events)
  objectType: string;        // Resolved slug: 'people' | 'companies'
  recordId: string;          // Record ID (for record events)
  mergedFromId?: string;     // For merge events
  noteId?: string;           // Note UUID (for note events)
  parentObjectId?: string;   // Parent object UUID (for note events)
  parentRecordId?: string;   // Parent record UUID (for note events)
  taskId?: string;           // Task UUID (for task events)
  listEntryId?: string;      // List entry UUID (for list-entry events)
  listId?: string;           // List UUID (for list-entry events)
}

/**
 * Parsed webhook payload containing multiple events.
 */
export interface ParsedWebhookPayload {
  webhookId: string;
  events: ParsedWebhookEvent[];
}

/**
 * Mapped company data ready for upsert.
 */
export interface MappedCompany {
  data: Partial<NewCompany>;
}

/**
 * Mapped person data ready for upsert. `parentCompanyExternalId` is set when
 * the source record had a parent-company link — the sync layer resolves it
 * via integration entity mappings and creates a `person_companies` row.
 */
export interface MappedPerson {
  data: Partial<NewPerson>;
  parentCompanyExternalId?: string;
}

/**
 * Generic sync entity type (shared with CrmSyncAdapter)
 */
export type SyncEntityType = 'person' | 'company' | 'lead' | 'opportunity' | 'activity' | 'pipeline';

/**
 * Generic external entity (for provider-agnostic webhook processing)
 */
export interface GenericExternalEntity {
  id: string;
  type: SyncEntityType;
  data: Record<string, unknown>;
  updatedAt: string;
  raw: unknown;
}

/**
 * Provider interface for the webhook worker.
 * Each integration provider (Attio, HubSpot, etc.) implements this.
 */
export interface IntegrationProvider {
  /** Verify the webhook signature from the provider. */
  verifyWebhookSignature(body: string, headers: Record<string, string>, secret: string): Promise<boolean>;

  /** Parse the raw webhook body into a list of events. */
  parseWebhookPayload(body: string): ParsedWebhookPayload;

  /** Resolve an object UUID to its slug (e.g., "people", "companies"). Cached per provider. */
  resolveObjectSlug(accessToken: string, objectId: string): Promise<string>;

  /** Fetch a full record from the provider's API. */
  fetchRecord(accessToken: string, objectType: string, recordId: string): Promise<ExternalRecord>;

  /** Fetch a note from the provider's API. */
  fetchNote(accessToken: string, noteId: string): Promise<ExternalNote>;

  /** Fetch a task from the provider's API. */
  fetchTask(accessToken: string, taskId: string): Promise<ExternalTask>;

  /** Fetch all lists from the provider's API. */
  fetchLists(accessToken: string): Promise<ExternalList[]>;

  /** Fetch a list entry from the provider's API. */
  fetchListEntry(accessToken: string, listId: string, entryId: string): Promise<ExternalListEntry>;

  /** Map a company record to a WeldSuite Company. */
  mapCompany(record: ExternalRecord): MappedCompany;

  /** Map a person record. `parentCompanyExternalId` is set when the record links to a company. */
  mapPerson(record: ExternalRecord): MappedPerson;

  // --- Generic sync interface (for new providers) ---

  /** Resolve a webhook event to a generic SyncEntityType. Optional — new providers implement this. */
  resolveEntityType?(event: ParsedWebhookEvent): SyncEntityType | undefined;

  /** Fetch a single entity using the generic interface. Optional — new providers implement this. */
  fetchEntityGeneric?(accessToken: string, entityType: SyncEntityType, externalId: string): Promise<GenericExternalEntity>;
}
