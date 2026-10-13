/**
 * The hand-off from WeldReach to WeldCRM.
 *
 * Prospects live in WeldReach, not in the CRM. A CRM person (and their
 * company) appears only when the prospect replies or a user adds the thread to
 * the CRM, and from then on `reach_prospects.person_id` links the two.
 * Everything goes through `@weldsuite/crm-domain`, so people, companies,
 * activities and opportunities get the same rows, validation and events as
 * when they are made in WeldCRM.
 *
 * Ownership matters here: CRM lists are owner-scoped, so a person created with
 * no owner would be invisible to the campaign owner. The campaign owner (else
 * its creator) becomes the owner when they are still a workspace member.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { emailDomain, isConsumerEmail } from '@weldsuite/app-api-client/schemas/reach';
import { reachProspects, type ReachCampaign, type ReachProspect } from '@weldsuite/db/schema';
import { createCompany } from '@weldsuite/crm-domain/companies';
import { createActivity } from '@weldsuite/crm-domain/activities';
import { createOpportunity, loadStage } from '@weldsuite/crm-domain/opportunities';
import {
  PersonDuplicateEmailError,
  addPersonToCrm,
  createPerson,
  isValidWorkspaceMember,
} from '@weldsuite/crm-domain/people';
import type { EntitySink } from './realtime';

const { people, companies, personCompanies } = schema;

/** What the CRM needs to know about the prospect (a reach prospect, or just an address from an unmatched sender). */
export interface CrmProspect {
  /** `reach_prospects.id`, when the sender is a known prospect. */
  id: string | null;
  email: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  title: string | null;
}

export function toCrmProspect(prospect: ReachProspect): CrmProspect {
  return {
    id: prospect.id,
    email: prospect.email,
    firstName: prospect.firstName,
    lastName: prospect.lastName,
    companyName: prospect.companyName,
    title: prospect.title,
  };
}

export interface CrmContext {
  db: Database;
  sink: EntitySink;
  /** Clerk user id the records are assigned to; null falls back to a system assignee. */
  actingUserId: string | null;
}

export interface CrmContact {
  personId: string;
  companyId: string | null;
  personCreated: boolean;
  companyCreated: boolean;
}

/** The user the CRM records belong to: the campaign owner, else its creator, if still a member. */
export async function resolveCrmOwner(db: Database, campaign: Pick<ReachCampaign, 'ownerId' | 'createdBy'> | null): Promise<string | null> {
  for (const candidate of [campaign?.ownerId, campaign?.createdBy]) {
    if (candidate && (await isValidWorkspaceMember(db, candidate))) return candidate;
  }
  return null;
}

/** `https://www.Acme.nl/path` or `acme.nl` to `acme.nl`. */
function hostOf(website: string | null | undefined): string {
  if (!website) return '';
  const trimmed = website.trim().toLowerCase();
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  return (withoutScheme.split(/[/?#]/)[0] ?? '').replace(/^www\./, '');
}

function titleCaseDomainName(domain: string): string {
  const label = domain.split('.')[0] ?? domain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

async function findPersonByEmail(db: Database, email: string): Promise<{ id: string; inCrm: boolean; firstName: string | null; lastName: string | null; fullName: string | null } | null> {
  const [row] = await db
    .select({ id: people.id, inCrm: people.inCrm, firstName: people.firstName, lastName: people.lastName, fullName: people.fullName })
    .from(people)
    .where(and(sql`lower(${people.email}) = ${email.toLowerCase()}`, isNull(people.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** A `LIKE` pattern matching any value that contains `value`. */
function likeContains(value: string): string {
  return '%' + value + '%';
}

/** An existing company for the prospect: by website host first, then by exact name. */
async function findCompany(db: Database, domain: string, name: string | null): Promise<{ id: string; name: string } | null> {
  if (domain !== '' && !isConsumerEmail(`x@${domain}`)) {
    const candidates = await db
      .select({ id: companies.id, name: companies.name, website: companies.website })
      .from(companies)
      .where(and(isNull(companies.deletedAt), sql`lower(${companies.website}) like ${likeContains(domain)}`))
      .limit(25);
    const hit = candidates.find((c) => hostOf(c.website) === domain);
    if (hit) return { id: hit.id, name: hit.name };
  }
  if (name && name.trim() !== '') {
    const [byName] = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(and(isNull(companies.deletedAt), sql`lower(${companies.name}) = ${name.trim().toLowerCase()}`))
      .limit(1);
    if (byName) return byName;
  }
  return null;
}

async function ensureCompany(
  ctx: CrmContext,
  prospect: CrmProspect,
  owner: string | null,
  options: { forceCreate: boolean },
): Promise<{ id: string; name: string; created: boolean } | null> {
  const domain = emailDomain(prospect.email);
  const found = await findCompany(ctx.db, domain, prospect.companyName);
  if (found) return { ...found, created: false };

  const consumer = isConsumerEmail(prospect.email);
  // A free-mail address says nothing about a company; make one only when the caller needs a company anyway.
  if (consumer && !options.forceCreate) return null;
  if (!prospect.companyName && consumer) {
    const personName = [prospect.firstName, prospect.lastName].filter(Boolean).join(' ');
    return createCompanyRow(ctx, personName || prospect.email, null, owner);
  }
  const name = prospect.companyName?.trim() || titleCaseDomainName(domain);
  return createCompanyRow(ctx, name, consumer ? null : domain, owner);
}

async function createCompanyRow(
  ctx: CrmContext,
  name: string,
  domain: string | null,
  owner: string | null,
): Promise<{ id: string; name: string; created: true }> {
  const created = await createCompany(ctx.db, {
    name: name.slice(0, 255),
    ...(domain ? { website: `https://${domain}` } : {}),
    source: 'weldreach',
    ...(owner ? { ownerId: owner } : {}),
  });
  await ctx.sink({
    entityType: 'company',
    action: 'created',
    entityId: created.id,
    data: { id: created.id, name: created.name, website: created.website, industry: created.industry },
  });
  return { id: created.id, name: created.name, created: true };
}

async function linkPersonToCompany(db: Database, personId: string, companyId: string): Promise<void> {
  const links = await db
    .select({ companyId: personCompanies.companyId, isPrimary: personCompanies.isPrimary, endedAt: personCompanies.endedAt })
    .from(personCompanies)
    .where(eq(personCompanies.personId, personId));
  const active = links.filter((l) => l.endedAt === null);
  if (active.some((l) => l.companyId === companyId)) return;
  const now = new Date();
  await db.insert(personCompanies).values({
    id: generateId('pc'),
    createdAt: now,
    updatedAt: now,
    personId,
    companyId,
    isPrimary: !active.some((l) => l.isPrimary),
  });
}

async function ensurePerson(
  ctx: CrmContext,
  prospect: CrmProspect,
  owner: string | null,
  companyId: string | null,
): Promise<{ id: string; created: boolean }> {
  const existing = await findPersonByEmail(ctx.db, prospect.email);
  if (existing) {
    // A mail-only identity (an email guest) joins the CRM; a CRM person stays as it is.
    if (!existing.inCrm) await addPersonToCrm(ctx.db, existing.id, owner ?? ctx.actingUserId ?? undefined);
    return { id: existing.id, created: false };
  }

  try {
    const row = await createPerson(ctx.db, {
      email: prospect.email,
      firstName: prospect.firstName ?? undefined,
      lastName: prospect.lastName ?? undefined,
      title: prospect.title ?? undefined,
      source: 'weldreach',
      inCrm: true,
      ...(owner ? { ownerId: owner } : {}),
      ...(companyId ? { companyIds: [companyId], primaryCompanyId: companyId } : {}),
    });
    await ctx.sink({
      entityType: 'person',
      action: 'created',
      entityId: row.id,
      data: {
        id: row.id,
        firstName: row.firstName,
        lastName: row.lastName,
        fullName: row.fullName,
        displayName: row.displayName,
        email: row.email,
        title: row.title,
      },
    });
    return { id: row.id, created: true };
  } catch (err) {
    // Lost a race with another writer: the person exists now.
    if (err instanceof PersonDuplicateEmailError) return { id: err.existingPersonId, created: false };
    throw err;
  }
}

/**
 * Find or create the CRM person and company for a prospect, link them, and
 * point `reach_prospects.person_id` at the person.
 */
export async function ensureCrmContact(
  ctx: CrmContext,
  prospect: CrmProspect,
  campaign: Pick<ReachCampaign, 'ownerId' | 'createdBy'> | null,
  options: { forceCompany?: boolean } = {},
): Promise<CrmContact> {
  const owner = (await resolveCrmOwner(ctx.db, campaign)) ?? null;
  const company = await ensureCompany(ctx, prospect, owner, { forceCreate: options.forceCompany ?? false });
  const person = await ensurePerson(ctx, prospect, owner, company?.id ?? null);
  if (company && !person.created) await linkPersonToCompany(ctx.db, person.id, company.id);

  if (prospect.id) {
    await ctx.db
      .update(reachProspects)
      .set({ personId: person.id, updatedAt: new Date() })
      .where(and(eq(reachProspects.id, prospect.id), isNull(reachProspects.personId)));
  }
  return { personId: person.id, companyId: company?.id ?? null, personCreated: person.created, companyCreated: company?.created ?? false };
}

export interface ReplyForCrm {
  messageIdHeader: string;
  subject: string | null;
  snippet: string | null;
  fromEmail: string;
  toEmail: string;
}

/**
 * A prospect replied: make sure the CRM knows them and log an email activity
 * ("Replied to outreach campaign <name>") on their record.
 */
export async function handOffReplyToCrm(
  ctx: CrmContext,
  input: { prospect: ReachProspect; campaign: ReachCampaign | null; message: ReplyForCrm },
): Promise<{ contact: CrmContact; activityId: string }> {
  const contact = await ensureCrmContact(ctx, toCrmProspect(input.prospect), input.campaign);
  const owner = (await resolveCrmOwner(ctx.db, input.campaign)) ?? ctx.actingUserId ?? 'system';
  const campaignName = input.campaign?.name ?? 'outreach';

  const { id, eventData } = await createActivity(
    ctx.db,
    {
      type: 'email',
      subject: `Replied to outreach campaign ${campaignName}`.slice(0, 255),
      description: input.message.snippet ?? undefined,
      personId: contact.personId,
      customerId: contact.companyId,
      emailMessageId: input.message.messageIdHeader.slice(0, 255),
      emailSubject: input.message.subject ?? undefined,
      emailFrom: input.message.fromEmail,
      emailTo: [input.message.toEmail],
      status: 'completed',
      assignedToId: owner,
    },
    owner,
  );
  await ctx.sink({ entityType: 'activity', action: 'created', entityId: id, data: eventData as unknown as Record<string, unknown> });
  return { contact, activityId: id };
}

export class CrmHandoffError extends Error {
  constructor(
    public readonly code: 'UNKNOWN_STAGE' | 'STAGE_PIPELINE_MISMATCH' | 'NO_COMPANY',
    message: string,
  ) {
    super(message);
    this.name = 'CrmHandoffError';
  }
}

export interface AddToCrmInput {
  /** The prospect the thread belongs to, or null for a sender that matched no prospect. */
  prospect: ReachProspect | null;
  /** The address that wrote, used when there is no prospect. */
  senderEmail: string;
  campaign: ReachCampaign | null;
  opportunity?: { pipelineId: string; stageId: string; name?: string };
}

/**
 * Add a thread's contact to the CRM on a user's request: person, company and,
 * when asked, an opportunity in the chosen pipeline stage.
 */
export async function addThreadToCrm(
  ctx: CrmContext,
  input: AddToCrmInput,
): Promise<{ personId: string; companyId: string | null; opportunityId: string | null }> {
  // Validate the target stage before anything is created.
  const stage = input.opportunity ? await loadStage(ctx.db, input.opportunity.stageId) : undefined;
  if (input.opportunity) {
    if (!stage) throw new CrmHandoffError('UNKNOWN_STAGE', 'Unknown pipeline stage');
    if (stage.pipeline && stage.pipeline !== input.opportunity.pipelineId) {
      throw new CrmHandoffError('STAGE_PIPELINE_MISMATCH', 'The stage does not belong to that pipeline');
    }
  }

  const prospect: CrmProspect = input.prospect
    ? toCrmProspect(input.prospect)
    : { id: null, email: input.senderEmail, firstName: null, lastName: null, companyName: null, title: null };
  const contact = await ensureCrmContact(ctx, prospect, input.campaign, { forceCompany: !!input.opportunity });
  if (!input.opportunity || !stage) return { personId: contact.personId, companyId: contact.companyId, opportunityId: null };

  if (!contact.companyId) throw new CrmHandoffError('NO_COMPANY', 'An opportunity needs a company');
  const owner = (await resolveCrmOwner(ctx.db, input.campaign)) ?? ctx.actingUserId ?? undefined;
  const personName = [prospect.firstName, prospect.lastName].filter(Boolean).join(' ') || prospect.email;
  const campaignSuffix = input.campaign ? ' (' + input.campaign.name + ')' : '';
  const defaultName = (prospect.companyName ?? personName) + campaignSuffix;
  const created = await createOpportunity(
    ctx.db,
    {
      name: (input.opportunity.name ?? defaultName).slice(0, 255),
      customerId: contact.companyId,
      primaryContactId: contact.personId,
      stage: stage.id,
      stageId: stage.id,
      pipeline: stage.pipeline ?? input.opportunity.pipelineId,
      leadSource: 'weldreach',
      ...(owner ? { ownerId: owner } : {}),
    },
    ctx.actingUserId ?? owner,
  );
  await ctx.sink({
    entityType: 'opportunity',
    action: 'created',
    entityId: created.id,
    data: created.eventData as unknown as Record<string, unknown>,
  });
  return { personId: contact.personId, companyId: contact.companyId, opportunityId: created.id };
}
