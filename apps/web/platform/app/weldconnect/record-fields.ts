/**
 * Fields of the record an entity-event workflow receives as `{{trigger.record.*}}`,
 * per entity type. The editor's variable picker lists them, the unknown-variable
 * check validates against them, and the Test dialog uses the samples.
 *
 * This mirrors what the publishers actually put in the event's `data` (which is
 * NOT always the full row), so keep it in sync with them:
 *   - lead:        apps/workers/crm-api/src/routes/leads/index.ts
 *   - person:      apps/workers/crm-api/src/routes/people/index.ts
 *   - company:     apps/workers/crm-api/src/routes/companies/index.ts
 *   - opportunity: apps/workers/crm-api/src/routes/opportunities/index.ts
 * An entity that is not listed here falls back to the generic picker entries.
 */

export interface RecordFieldDef {
  /** Path below the record, e.g. `firstName` or `address.city`. Also the key of its label in `weldconnect.recordFields`. */
  path: string;
  type?: 'string' | 'number' | 'boolean';
  /** Key of the label in `weldconnect.recordFields`, when it is not `path` (a `title` that is not a job title). */
  labelKey?: string;
  /** Events whose payload carries the field. Omitted = every event of the entity. */
  events?: readonly string[];
  /** Value pre-filled in the Test dialog. */
  sample?: string;
}

// `deleted`, `qualified` and `converted` only carry id, email and status.
const LEAD_ROW_EVENTS = ['created', 'updated'] as const;
const OPPORTUNITY_CHANGE_EVENTS = ['updated', 'stage_changed', 'won', 'lost'] as const;

const leadRowField = (path: string, sample?: string, type?: RecordFieldDef['type']): RecordFieldDef => ({
  path,
  sample,
  type,
  events: LEAD_ROW_EVENTS,
});

const RECORD_FIELDS: Record<string, readonly RecordFieldDef[]> = {
  lead: [
    { path: 'id', sample: 'lead_test' },
    leadRowField('firstName', 'Jane'),
    leadRowField('lastName', 'Doe'),
    leadRowField('fullName', 'Jane Doe'),
    { path: 'email', sample: 'jane.doe@example.com' },
    leadRowField('phone', '+31 20 123 4567'),
    leadRowField('mobile'),
    leadRowField('companyName', 'Acme Inc.'),
    leadRowField('title', 'Head of Operations'),
    leadRowField('website', 'acme.com'),
    leadRowField('address.line1'),
    leadRowField('address.postalCode'),
    leadRowField('address.city', 'Amsterdam'),
    leadRowField('address.country', 'NL'),
    leadRowField('source', 'website'),
    { path: 'status', sample: 'new' },
    leadRowField('rating'),
    leadRowField('score', undefined, 'number'),
    leadRowField('ownerId'),
  ],
  person: [
    { path: 'id', sample: 'person_test' },
    { path: 'firstName', sample: 'Jane' },
    { path: 'lastName', sample: 'Doe' },
    { path: 'fullName', sample: 'Jane Doe' },
    { path: 'displayName', sample: 'Jane Doe' },
    { path: 'email', sample: 'jane.doe@example.com' },
    { path: 'title', sample: 'Head of Operations' },
  ],
  company: [
    { path: 'id', sample: 'company_test' },
    { path: 'name', sample: 'Acme Inc.' },
    { path: 'website', sample: 'acme.com' },
    { path: 'industry', sample: 'Manufacturing' },
    { path: 'email', sample: 'info@acme.com', events: ['created'] },
    { path: 'phone', sample: '+31 20 123 4567', events: ['created'] },
    { path: 'status', sample: 'active', events: ['created'] },
  ],
  opportunity: [
    { path: 'id', sample: 'opportunity_test' },
    { path: 'name', sample: 'Acme Inc. - annual plan' },
    { path: 'amount', sample: '12000' },
    { path: 'stage', sample: 'Proposal' },
    { path: 'status', sample: 'open' },
    { path: 'customerId' },
    { path: 'ownerId', events: ['created', ...OPPORTUNITY_CHANGE_EVENTS] },
    { path: 'currency', sample: 'EUR', events: ['created'] },
    { path: 'pipelineId', events: ['created'] },
    { path: 'stageId', events: OPPORTUNITY_CHANGE_EVENTS },
  ],
  // WeldMerge: the payloads of services/mappers.ts (issues), services/pr-sync.ts (pull requests)
  // and services/releases.ts (releases) in merge-api. `merge_release.shipped` carries the shipped-event data.
  merge_issue: [
    { path: 'id', sample: 'mis_test' },
    { path: 'key', sample: 'PLAT-209' },
    { path: 'title', labelKey: 'merge.title', sample: 'Login is slow' },
    { path: 'status', sample: 'todo' },
    { path: 'priority', sample: '2' },
    { path: 'teamId' },
    { path: 'assigneeUserId' },
  ],
  merge_pull_request: [
    { path: 'id', sample: 'mpr_test' },
    { path: 'number', sample: '42', type: 'number' },
    { path: 'title', labelKey: 'merge.title', sample: 'Fix the login' },
    { path: 'state', sample: 'open' },
    { path: 'url', sample: 'https://github.com/acme/api/pull/42' },
    { path: 'authorLogin', sample: 'octocat' },
    { path: 'repositoryId' },
  ],
  merge_release: [
    { path: 'id', sample: 'mrl_test', events: ['created', 'updated', 'deleted'] },
    { path: 'releaseId', sample: 'mrl_test', events: ['shipped'] },
    { path: 'pullRequestIds', labelKey: 'merge.pullRequestIds', events: ['shipped'] },
    { path: 'issueIds', labelKey: 'merge.issueIds', events: ['shipped'] },
    { path: 'deskTicketIds', labelKey: 'merge.deskTicketIds', events: ['shipped'] },
    { path: 'name', sample: 'Spring release' },
    { path: 'version', sample: 'v1.4.0' },
    { path: 'status', events: ['created', 'updated', 'deleted'] },
    { path: 'repositoryId' },
    { path: 'teamId', events: ['created', 'updated', 'deleted'] },
  ],
};

/**
 * The record fields available for `entityType` on `eventType`, or undefined
 * when the entity's payload is not catalogued. Without an event (not chosen
 * yet) every field of the entity is returned.
 */
export function getRecordFields(
  entityType: string | undefined,
  eventType: string | undefined,
): RecordFieldDef[] | undefined {
  const fields = entityType ? RECORD_FIELDS[entityType] : undefined;
  if (!fields) return undefined;
  return fields.filter((field) => !eventType || !field.events || field.events.includes(eventType));
}
