/**
 * ProcessResponse step: WeldCRM (ADR FORMS-006, docs/plans/weldforms.md,
 * "Integrations"). Per enabled `crm` integration, as the member who set it up:
 *
 *  - find the person by email in the CRM, or create one (a hidden mail identity
 *    with that email is promoted into the CRM), or create a lead;
 *  - the company, from a company question or the email's domain;
 *  - the mapped fields, each "always overwrite" or "only fill empty", standard
 *    (`firstName`, `lastName`, `email`, `directPhone`, `mobilePhone`, `title`,
 *    `department`) or `custom:<customFieldId>`;
 *  - a CRM list, tags, and an activity "Submitted <form>" linking to the response;
 *  - `form_responses.person_id`.
 *
 * Writes through `@weldsuite/crm-domain` and `@weldsuite/core-domain`. Safe to
 * run again: the person is found by email, the record made is remembered on the
 * action row, list members and the activity are not duplicated. A response edit
 * (mode `update`) updates the same person; a lead is left as it was.
 */

import { and, eq, ilike, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { crmIntegrationConfigSchema, type CrmIntegrationConfig } from '@weldsuite/app-api-client/schemas/weldforms';
import { createActivity } from '@weldsuite/crm-domain/activities';
import { createCompany } from '@weldsuite/crm-domain/companies';
import { createLead } from '@weldsuite/crm-domain/leads';
import { PersonDuplicateEmailError, createPersonDetailed, updatePerson } from '@weldsuite/crm-domain/people';
import { getDefinitionsForEntityType, setValues, type CustomFieldDefinitionRow } from '@weldsuite/core-domain/custom-field-values';
import { CreatorForbiddenError, loadCreatorAccess, type CreatorAccess } from '../../services/creator-access';
import { answerText, emailAnswer, emitRecordEvent, recordedEntity, rememberEntity, responseUrl } from '../../services/integration-support';
import type { IntegrationStep, ProcessContext, StepResult } from './types';

const { people, companies, personCompanies, lists, listMembers, crmLeads, crmActivities, formResponses } = schema;
type Integration = Parameters<IntegrationStep['run']>[1];
type PersonRow = typeof people.$inferSelect;

/** The standard fields a mapping may fill, on a person and (with `directPhone`/`mobilePhone` renamed) on a lead. */
export const CRM_STANDARD_FIELDS = ['firstName', 'lastName', 'email', 'directPhone', 'mobilePhone', 'title', 'department'] as const;
type StandardField = (typeof CRM_STANDARD_FIELDS)[number];

const isStandard = (key: string): key is StandardField => (CRM_STANDARD_FIELDS as readonly string[]).includes(key);

/** Free mail providers: their domain says nothing about the person's company. */
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net', 'aol.com', 'msn.com']);

interface Mapped {
  standard: Partial<Record<StandardField, string>>;
  /** Custom field values by definition, as the CRM stores them (slug → typed value). */
  custom: Array<{ definition: CustomFieldDefinitionRow; value: unknown; mode: 'overwrite' | 'fill_empty' }>;
  modes: Partial<Record<StandardField, 'overwrite' | 'fill_empty'>>;
}

function typed(definition: CustomFieldDefinitionRow, text: string): unknown {
  switch (definition.fieldType) {
    case 'number':
    case 'currency':
    case 'decimal': {
      const n = Number(text.replace(',', '.'));
      return Number.isFinite(n) ? n : text;
    }
    case 'boolean':
    case 'checkbox':
      return /^(yes|true|1|accepted)$/i.test(text);
    default:
      return text;
  }
}

async function mapAnswers(ctx: ProcessContext, config: CrmIntegrationConfig, entity: 'person' | 'lead'): Promise<Mapped> {
  const mapped: Mapped = { standard: {}, custom: [], modes: {} };
  const defs = config.mappings.some((m) => m.crmField.startsWith('custom:')) ? await getDefinitionsForEntityType(ctx.db, entity) : [];
  for (const mapping of config.mappings) {
    const text = answerText(ctx.definition, ctx.response, mapping.blockId, mapping.part);
    if (!text) continue;
    if (isStandard(mapping.crmField)) {
      mapped.standard[mapping.crmField] = text;
      mapped.modes[mapping.crmField] = mapping.mode;
    } else if (mapping.crmField.startsWith('custom:')) {
      const definition = defs.find((d) => d.id === mapping.crmField.slice('custom:'.length));
      if (definition) mapped.custom.push({ definition, value: typed(definition, text), mode: mapping.mode });
    }
  }
  return mapped;
}

const isEmpty = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

// ── Company ──────────────────────────────────────────────────────────────────

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function hostOf(website: string | null): string {
  if (!website) return '';
  try {
    return new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return website.toLowerCase();
  }
}

async function findCompany(db: Database, name: string | null, domain: string | null): Promise<string | null> {
  if (name) {
    const [byName] = await db
      .select({ id: companies.id })
      .from(companies)
      .where(and(isNull(companies.deletedAt), sql`lower(${companies.displayName}) = ${name.toLowerCase()}`))
      .limit(1);
    if (byName) return byName.id;
  }
  if (domain) {
    const candidates = await db
      .select({ id: companies.id, website: companies.website })
      .from(companies)
      .where(and(isNull(companies.deletedAt), ilike(companies.website, `%${escapeLike(domain)}%`)))
      .limit(20);
    const hit = candidates.find((c) => hostOf(c.website) === domain);
    if (hit) return hit.id;
  }
  return null;
}

async function ensureCompany(ctx: ProcessContext, config: CrmIntegrationConfig, email: string, userId: string): Promise<string | null> {
  const fromField = config.companyFieldId ? answerText(ctx.definition, ctx.response, config.companyFieldId, 'company') : '';
  const name = fromField || null;
  const domain = email.split('@')[1] ?? '';
  const usableDomain = domain && !FREE_MAIL.has(domain) ? domain : null;
  if (!name && !usableDomain) return null;
  const found = await findCompany(ctx.db, name, usableDomain);
  if (found) return found;
  const created = await createCompany(
    ctx.db,
    { name: name ?? usableDomain!, ...(usableDomain ? { website: `https://${usableDomain}` } : {}), ownerId: userId, source: 'weldforms' } as never,
    { createdBy: userId },
  );
  return created.id;
}

// ── Person ───────────────────────────────────────────────────────────────────

export async function findPersonByEmail(db: Database, email: string): Promise<PersonRow | null> {
  const [row] = await db
    .select()
    .from(people)
    .where(and(sql`lower(${people.email}) = ${email}`, isNull(people.deletedAt), eq(people.inCrm, true)))
    .limit(1);
  return row ?? null;
}

async function personById(db: Database, id: string): Promise<PersonRow | null> {
  const [row] = await db.select().from(people).where(and(eq(people.id, id), isNull(people.deletedAt))).limit(1);
  return row ?? null;
}

/** The fields to write: all of them on a new record, only the ones the mode allows on an existing one. */
function writable(existing: PersonRow | null, mapped: Mapped): Partial<Record<Exclude<StandardField, 'email'>, string>> {
  const out: Partial<Record<Exclude<StandardField, 'email'>, string>> = {};
  for (const key of CRM_STANDARD_FIELDS) {
    if (key === 'email') continue;
    const value = mapped.standard[key];
    if (value === undefined) continue;
    if (existing && mapped.modes[key] !== 'overwrite' && !isEmpty(existing[key])) continue;
    out[key] = value;
  }
  return out;
}

function customBlob(existing: PersonRow | null, mapped: Mapped): Record<string, unknown> | undefined {
  if (mapped.custom.length === 0) return undefined;
  const current = ((existing as { customFields?: Record<string, unknown> | null } | null)?.customFields ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...current };
  for (const { definition, value, mode } of mapped.custom) {
    if (mode === 'fill_empty' && !isEmpty(current[definition.slug])) continue;
    next[definition.slug] = value;
  }
  return next;
}

function personEvent(row: PersonRow): Record<string, unknown> {
  return { id: row.id, firstName: row.firstName, lastName: row.lastName, fullName: row.fullName, displayName: row.displayName, email: row.email, title: row.title };
}

async function upsertPerson(
  ctx: ProcessContext,
  integration: Integration,
  config: CrmIntegrationConfig,
  email: string,
  mapped: Mapped,
  userId: string,
  recorded: { entityType: string; entityId: string } | null,
): Promise<PersonRow> {
  const tags = config.tags;
  const byRecord = recorded?.entityType === 'person' ? await personById(ctx.db, recorded.entityId) : null;
  const existing = byRecord ?? (await findPersonByEmail(ctx.db, email));
  if (existing) return updateExisting(ctx, integration, existing, mapped, tags);

  try {
    const { row, promoted } = await createPersonDetailed(ctx.db, {
      email,
      ...writable(null, mapped),
      inCrm: true,
      source: 'weldforms',
      ownerId: userId,
      ...(tags.length ? { tags } : {}),
      ...(customBlob(null, mapped) ? { customFields: customBlob(null, mapped) } : {}),
    } as never);
    await rememberEntity(ctx.db, ctx, integration, 'person', row.id);
    await emitRecordEvent(ctx, integration, 'person', promoted ? 'updated' : 'created', row.id, personEvent(row));
    return row;
  } catch (err) {
    // Someone created them between the lookup and the write: update that person.
    if (err instanceof PersonDuplicateEmailError) {
      const raced = await personById(ctx.db, err.existingPersonId);
      if (raced) return updateExisting(ctx, integration, raced, mapped, tags);
    }
    throw err;
  }
}

async function updateExisting(ctx: ProcessContext, integration: Integration, existing: PersonRow, mapped: Mapped, tags: string[]): Promise<PersonRow> {
  const fields = writable(existing, mapped);
  const custom = customBlob(existing, mapped);
  const mergedTags = tags.length ? [...new Set([...(existing.tags ?? []), ...tags])] : undefined;
  const changed = Object.keys(fields).length > 0 || custom !== undefined || (mergedTags !== undefined && mergedTags.length !== (existing.tags ?? []).length);
  await rememberEntity(ctx.db, ctx, integration, 'person', existing.id);
  if (!changed) return existing;
  const result = await updatePerson(ctx.db, existing.id, {
    ...fields,
    ...(mergedTags ? { tags: mergedTags } : {}),
    ...(custom ? { customFields: custom } : {}),
  } as never);
  const row = result?.row ?? existing;
  await emitRecordEvent(ctx, integration, 'person', 'updated', row.id, personEvent(row));
  return row;
}

async function linkCompany(db: Database, personId: string, companyId: string): Promise<void> {
  const [linked] = await db
    .select({ id: personCompanies.id })
    .from(personCompanies)
    .where(and(eq(personCompanies.personId, personId), eq(personCompanies.companyId, companyId), isNull(personCompanies.endedAt)))
    .limit(1);
  if (linked) return;
  const [primary] = await db
    .select({ id: personCompanies.id })
    .from(personCompanies)
    .where(and(eq(personCompanies.personId, personId), eq(personCompanies.isPrimary, true), isNull(personCompanies.endedAt)))
    .limit(1);
  const now = new Date();
  await db.insert(personCompanies).values({ id: generateId('pc'), createdAt: now, updatedAt: now, personId, companyId, isPrimary: !primary });
}

async function addToList(db: Database, listId: string, personId: string, userId: string): Promise<void> {
  const [list] = await db.select({ kind: lists.kind }).from(lists).where(and(eq(lists.id, listId), isNull(lists.deletedAt))).limit(1);
  // A list that is gone or holds companies is left alone: the rest of the step still counts.
  if (list?.kind !== 'person') return;
  await db.insert(listMembers).values({ id: generateId('lm'), listId, entityId: personId, addedBy: userId }).onConflictDoNothing();
}

// ── Activity ─────────────────────────────────────────────────────────────────

/** The note on the record, once per response and kind of run (a repeat of the same run finds it). */
async function logActivity(
  ctx: ProcessContext,
  integration: Integration,
  target: { personId?: string; leadId?: string; name: string },
): Promise<void> {
  const mode = ctx.params.mode;
  const key = `${ctx.response.id}:${mode}:${integration.id}`;
  const [existing] = await ctx.db
    .select({ id: crmActivities.id })
    .from(crmActivities)
    .where(sql`${crmActivities.customFields}->>'formResponse' = ${key}`)
    .limit(1);
  if (existing) return;
  const url = responseUrl(ctx.env, ctx.form.id, ctx.response.id);
  const subject = (mode === 'update' ? `Updated response to ${ctx.form.title}` : `Submitted ${ctx.form.title}`).slice(0, 255);
  const { id, eventData } = await createActivity(
    ctx.db,
    {
      type: 'note',
      subject,
      description: `${url}`,
      relatedTo: target.leadId ? 'lead' : 'contact',
      relatedToId: target.leadId ?? target.personId,
      relatedToName: target.name.slice(0, 255),
      personId: target.personId,
      leadId: target.leadId,
      status: 'completed',
      customFields: { formResponse: key, formId: ctx.form.id, responseId: ctx.response.id },
    },
    integration.createdByUserId,
  );
  await emitRecordEvent(ctx, integration, 'activity', 'created', id, eventData as unknown as Record<string, unknown>);
}

// ── Lead ─────────────────────────────────────────────────────────────────────

async function createLeadFor(
  ctx: ProcessContext,
  integration: Integration,
  email: string,
  mapped: Mapped,
  companyName: string | null,
  userId: string,
): Promise<{ id: string; name: string }> {
  const { standard } = mapped;
  const { id, row, eventData } = await createLead(
    ctx.db,
    {
      email,
      firstName: standard.firstName,
      lastName: standard.lastName,
      title: standard.title,
      phone: standard.directPhone,
      mobile: standard.mobilePhone,
      companyName: companyName ?? undefined,
      // The lead has no department column: keep what the respondent said where a person reads it.
      notes: standard.department ? `Department: ${standard.department}` : undefined,
      source: 'website',
      channel: 'weldforms',
      campaign: ctx.form.title.slice(0, 255),
    } as never,
    userId,
  );
  await rememberEntity(ctx.db, ctx, integration, 'lead', id);
  if (mapped.custom.length > 0) {
    const values = Object.fromEntries(mapped.custom.map((c) => [c.definition.slug, c.value]));
    await setValues(ctx.db, 'lead', id, values, { enforceRequired: false });
  }
  await emitRecordEvent(ctx, integration, 'lead', 'created', id, eventData as unknown as Record<string, unknown>);
  return { id, name: [row.firstName, row.lastName].filter(Boolean).join(' ') || email };
}

// ── The step ─────────────────────────────────────────────────────────────────

/** Everything the run writes, checked before it writes anything. */
function requirePermissions(access: CreatorAccess, config: CrmIntegrationConfig, personExists: boolean): void {
  if (config.target === 'lead') {
    access.require('leads:create', 'weldcrm', 'create leads');
  } else if (personExists) {
    access.require('people:update', 'weldcrm', 'update people');
  } else {
    access.require('people:create', 'weldcrm', 'create people');
  }
  if (config.createCompany) access.require('companies:create', 'weldcrm', 'create companies');
  if (config.listId) access.require('companies:update', 'weldcrm', 'add people to lists');
  if (config.logActivity) access.require('activities:create', 'weldcrm', 'log activities');
}

export async function runCrmStep(ctx: ProcessContext, integration: Integration): Promise<StepResult> {
  const parsed = crmIntegrationConfigSchema.safeParse(integration.config);
  if (!parsed.success) return { status: 'skipped', reason: 'The CRM integration is not set up correctly' };
  const config = parsed.data;
  const userId = integration.createdByUserId;

  const email = emailAnswer(ctx.definition, ctx.response, config.emailFieldId);
  if (!email) return { status: 'skipped', reason: 'The response has no email address in the chosen question' };

  try {
    const access = await loadCreatorAccess(ctx.db, ctx.env, userId);
    const recorded = await recordedEntity(ctx.db, ctx, integration);

    if (config.target === 'lead') {
      if (recorded?.entityType === 'lead') {
        const [lead] = await ctx.db.select({ id: crmLeads.id }).from(crmLeads).where(and(eq(crmLeads.id, recorded.entityId), isNull(crmLeads.deletedAt))).limit(1);
        if (lead) {
          return ctx.params.mode === 'update'
            ? { status: 'skipped', reason: 'A lead is not changed when the response is edited' }
            : { status: 'done', entityType: 'lead', entityId: lead.id };
        }
      }
      requirePermissions(access, config, false);
      const mapped = await mapAnswers(ctx, config, 'lead');
      const companyName = config.createCompany && config.companyFieldId ? answerText(ctx.definition, ctx.response, config.companyFieldId, 'company') || null : null;
      const lead = await createLeadFor(ctx, integration, email, mapped, companyName, userId);
      if (config.logActivity) await logActivity(ctx, integration, { leadId: lead.id, name: lead.name });
      return { status: 'done', entityType: 'lead', entityId: lead.id };
    }

    const known = (recorded?.entityType === 'person' ? await personById(ctx.db, recorded.entityId) : null) ?? (await findPersonByEmail(ctx.db, email));
    requirePermissions(access, config, known !== null);

    const mapped = await mapAnswers(ctx, config, 'person');
    const person = await upsertPerson(ctx, integration, config, email, mapped, userId, recorded);
    if (config.createCompany) {
      const companyId = await ensureCompany(ctx, config, email, userId);
      if (companyId) await linkCompany(ctx.db, person.id, companyId);
    }
    if (config.listId) await addToList(ctx.db, config.listId, person.id, userId);
    await ctx.db.update(formResponses).set({ personId: person.id }).where(eq(formResponses.id, ctx.response.id));
    if (config.logActivity) await logActivity(ctx, integration, { personId: person.id, name: person.displayName ?? email });
    return { status: 'done', entityType: 'person', entityId: person.id };
  } catch (err) {
    if (err instanceof CreatorForbiddenError) return { status: 'skipped', reason: err.message };
    throw err;
  }
}

export const crmStep: IntegrationStep = { type: 'integration', kind: 'crm', name: 'crm', run: runCrmStep };
