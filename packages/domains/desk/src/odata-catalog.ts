/**
 * The OData feed's catalogue: every entity set, its table and its columns, as
 * plain data. The service document, `$metadata`, the SQL and the validation of
 * `$select` / `$filter` / `$orderby` are all driven from it, and property names
 * in a request are only ever resolved against it (never put in SQL as text).
 *
 * Serialisable on purpose (no functions, no Drizzle objects): the Rust backend
 * reads the same catalogue as JSON (`odataCatalogJson`). `odata-catalog.test.ts`
 * checks every table and column against the Drizzle schema, so a renamed
 * column fails CI.
 *
 * Explicit column lists only. Message bodies, attachments, recording URLs and
 * anything in `@weldsuite/db/lib/sensitive-columns` are not listed here, and
 * the test keeps them out.
 */

export const ODATA_NAMESPACE = 'WeldSuite.Desk';
export const ODATA_CONTAINER = 'Feed';
/** Rows per response; more rows than this come with `@odata.nextLink`. */
export const ODATA_PAGE_SIZE = 1000;

export type EdmType =
  | 'Edm.String'
  | 'Edm.Int32'
  | 'Edm.Int64'
  | 'Edm.Boolean'
  | 'Edm.DateTimeOffset'
  | 'Edm.Double'
  | 'Collection(Edm.String)';

export interface ODataProperty {
  /** Name on the wire, camelCase like the rest of the public API. */
  name: string;
  /** SQL column, or a fixed SQL expression for a derived value. */
  column: string;
  type: EdmType;
  nullable: boolean;
  filterable: boolean;
  sortable: boolean;
  /** The column is `timestamptz` (the others are `timestamp` holding UTC). */
  withTimeZone?: boolean;
}

export interface ODataEntitySet {
  name: string;
  entityType: string;
  /** SQL table name. */
  table: string;
  /** Name of the key property (a string property, never null). */
  key: string;
  /** SQL column holding the soft-delete time: rows where it is set are not served. */
  softDelete?: string;
  properties: ODataProperty[];
}

export interface ODataCatalog {
  namespace: string;
  container: string;
  pageSize: number;
  entitySets: ODataEntitySet[];
}

const snake = (name: string): string => name.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);

interface Opts {
  column?: string;
  sort?: boolean;
  filter?: boolean;
  tz?: boolean;
}

/** A property. The column defaults to the snake_case name. */
function prop(name: string, type: EdmType, nullable: boolean, opts: Opts = {}): ODataProperty {
  const out: ODataProperty = {
    name,
    column: opts.column ?? snake(name),
    type,
    nullable,
    filterable: opts.filter ?? true,
    sortable: opts.sort ?? type !== 'Collection(Edm.String)',
  };
  if (opts.tz) out.withTimeZone = true;
  return out;
}

const str = (name: string, nullable = false, opts: Opts = {}) => prop(name, 'Edm.String', nullable, opts);
const int = (name: string, nullable = false, opts: Opts = {}) => prop(name, 'Edm.Int32', nullable, opts);
const bool = (name: string, nullable = false, opts: Opts = {}) => prop(name, 'Edm.Boolean', nullable, opts);
const time = (name: string, nullable = false, opts: Opts = {}) => prop(name, 'Edm.DateTimeOffset', nullable, opts);
/** A JSON array of strings; an empty one when the column is null. */
const list = (name: string, opts: Opts = {}) => prop(name, 'Collection(Edm.String)', false, opts);
/** A long text: filterable, not sortable. */
const text = (name: string) => str(name, true, { sort: false });

const created = () => time('createdAt');
const updated = () => time('updatedAt');

export const ODATA_ENTITY_SETS: ODataEntitySet[] = [
  {
    name: 'Conversations',
    entityType: 'Conversation',
    table: 'desk_conversations',
    key: 'id',
    properties: [
      str('id'),
      int('conversationNumber'),
      str('title', true),
      str('state'),
      str('channel'),
      str('name', true),
      str('email', true),
      str('contactId', true),
      str('assigneeId', true),
      str('ticketTypeId', true),
      str('priority', true),
      str('impact', true),
      str('urgency', true),
      list('tags'),
      str('departmentId', true),
      created(),
      updated(),
      time('waitingSince', true),
      time('lastMessageAt', true),
      int('rating', true),
      time('ratedAt', true),
      str('externalId', true),
      str('slaPolicyId', true),
      str('slaStatus', true),
      time('slaDueAt', true),
      str('slaMetric', true),
      time('firstResponseAt', true),
      int('firstResponseSeconds', true),
      time('resolvedAt', true),
      int('resolutionSeconds', true),
      str('parentConversationId', true),
      bool('isMajorIncident'),
      str('mergedIntoId', true),
      str('language', true),
      str('problemId', true),
      str('catalogItemId', true),
      str('approvalStatus', true),
    ],
  },
  {
    name: 'Messages',
    entityType: 'Message',
    table: 'desk_messages',
    key: 'id',
    properties: [
      str('id'),
      str('conversationId'),
      created(),
      str('kind'),
      str('authorType'),
      str('authorId', true),
      str('eventType', true, { column: "metadata->>'eventType'" }),
    ],
  },
  {
    name: 'SlaClocks',
    entityType: 'SlaClock',
    table: 'desk_sla_clocks',
    key: 'id',
    properties: [
      str('id'),
      created(),
      updated(),
      str('conversationId'),
      str('metric'),
      str('policyId', true),
      int('targetMinutes'),
      int('warnBeforeMinutes', true),
      str('status'),
      time('startedAt'),
      int('elapsedSeconds'),
      time('dueAt', true),
      time('warnAt', true),
      time('breachedAt', true),
      time('completedAt', true),
      time('warnedAt', true),
      time('breachNotifiedAt', true),
      time('nextCheckAt', true),
    ],
  },
  {
    name: 'Calls',
    entityType: 'Call',
    table: 'voip_calls',
    key: 'id',
    properties: [
      str('id'),
      created(),
      str('userId'),
      str('direction'),
      str('status'),
      str('fromNumber'),
      str('toNumber'),
      time('initiatedAt'),
      time('answeredAt', true),
      time('endedAt', true),
      int('duration', true),
      time('queueEnteredAt', true),
      time('agentAnsweredAt', true),
      str('answeredByUserId', true),
      str('outcome', true),
      str('departmentId', true),
      str('deskConversationId', true),
      bool('isRecorded', true),
      str('hangupCause', true),
      str('sipTrunkId', true),
    ],
  },
  {
    name: 'Teams',
    entityType: 'Team',
    table: 'helpdesk_departments',
    key: 'id',
    softDelete: 'deleted_at',
    properties: [
      str('id'),
      str('name'),
      text('description'),
      str('email', true),
      str('managerId', true),
      str('managerName', true),
      list('agentIds'),
      int('agentCount', true),
      bool('autoAssignment', true),
      bool('roundRobinAssignment', true),
      str('defaultPriority', true),
      bool('isActive'),
      int('sortOrder', true),
      created(),
      updated(),
    ],
  },
  {
    name: 'TicketTypes',
    entityType: 'TicketType',
    table: 'helpdesk_ticket_types',
    key: 'id',
    softDelete: 'deleted_at',
    properties: [
      str('id'),
      str('name'),
      str('description', true),
      str('category', true),
      bool('disableAiAutofill', true),
      str('defaultPriority', true),
      str('defaultAssigneeId', true),
      str('defaultDepartmentId', true),
      bool('isActive'),
      int('sortOrder', true),
      created(),
      updated(),
    ],
  },
  {
    name: 'Agents',
    entityType: 'Agent',
    table: 'workspace_members',
    key: 'id',
    softDelete: 'deleted_at',
    properties: [
      str('id'),
      str('userId'),
      str('name', true),
      str('email', true),
      str('role'),
      str('roleId', true),
      str('title', true),
      str('status'),
      str('memberType'),
      bool('isActive', false, { column: "status = 'ACTIVE'" }),
      time('createdAt', false, { tz: true }),
      time('updatedAt', false, { tz: true }),
    ],
  },
  {
    name: 'Problems',
    entityType: 'Problem',
    table: 'desk_problems',
    key: 'id',
    properties: [
      str('id'),
      created(),
      updated(),
      int('problemNumber'),
      str('title'),
      text('description'),
      str('status'),
      str('priority', true),
      text('rootCause'),
      text('workaround'),
      text('resolution'),
      str('assigneeId', true),
      str('departmentId', true),
      str('articleId', true),
      time('knownErrorAt', true),
      time('resolvedAt', true),
      time('closedAt', true),
      str('createdById', true),
    ],
  },
  {
    name: 'CatalogItems',
    entityType: 'CatalogItem',
    table: 'desk_catalog_items',
    key: 'id',
    properties: [
      str('id'),
      str('name'),
      str('category', true),
      str('ticketTypeId'),
      str('departmentId', true),
      bool('isActive'),
      created(),
      updated(),
    ],
  },
  {
    name: 'Articles',
    entityType: 'Article',
    table: 'helpdesk_articles',
    key: 'id',
    softDelete: 'deleted_at',
    properties: [
      str('id'),
      str('title'),
      str('status'),
      str('visibility'),
      str('locale', true),
      str('categoryId', true),
      str('categoryName', true),
      int('viewCount', true),
      int('likeCount', true),
      int('dislikeCount', true),
      int('helpfulCount', true),
      int('notHelpfulCount', true),
      created(),
      updated(),
      time('publishedAt', true),
    ],
  },
];

export const ODATA_CATALOG: ODataCatalog = {
  namespace: ODATA_NAMESPACE,
  container: ODATA_CONTAINER,
  pageSize: ODATA_PAGE_SIZE,
  entitySets: ODATA_ENTITY_SETS,
};

/** The catalogue as JSON text, for the Rust backend. */
export function odataCatalogJson(): string {
  return JSON.stringify(ODATA_CATALOG, null, 2);
}

export function findEntitySet(name: string): ODataEntitySet | undefined {
  return ODATA_ENTITY_SETS.find((set) => set.name === name);
}

export function findProperty(set: ODataEntitySet, name: string): ODataProperty | undefined {
  return set.properties.find((p) => p.name === name);
}

/** A plain column name (as opposed to a fixed SQL expression). */
export function isPlainColumn(column: string): boolean {
  return /^[a-z_][a-z0-9_]*$/.test(column);
}
