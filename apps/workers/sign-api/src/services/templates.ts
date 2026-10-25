/**
 * Templates: a reusable request with named roles ("Client", "Director") in
 * place of people. A template is a `sign_envelopes` row of kind `template`
 * (always a draft) with its own documents, fields and recipient rows; a role
 * is a recipient row with `role_name` set and, optionally, the name and email
 * of whoever usually fills it. Templates belong to the workspace: anyone with
 * `sign_templates:read` sees them all.
 *
 * Using a template copies it into a new draft request: the PDFs are copied to
 * the draft's own keys (so deleting either never touches the other), every
 * role becomes a recipient with the person given for it, and the fields move
 * along.
 */

import { and, asc, count, desc, eq, ilike, inArray, isNull, max, ne, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { SignEnvelope, SignRecipient } from '@weldsuite/db/schema';
import {
  SIGN_LIMITS,
  type CreateSignTemplateInput,
  type CreateSignTemplateRoleInput,
  type SignEnvelopeDetail,
  type SignTemplateRecipientInput,
  type SignTemplateSummary,
  type UpdateSignTemplateRoleInput,
  type UseSignTemplateInput,
} from '@weldsuite/app-api-client/schemas/weldsign';
import { invalid, notFound } from './errors';
import { createEnvelope, deleteDraft, getEnvelopeDetail, type SignViewer } from './envelopes';
import { documentKey } from './documents';
import { addRecipient, getRecipient } from './recipients';
import type { SignDefaults } from './settings';

const { signEnvelopes, signDocuments, signRecipients, signFields } = schema;

/** A live template, or `not_found`. */
export async function loadTemplate(db: Database, id: string): Promise<SignEnvelope> {
  const [row] = await db
    .select()
    .from(signEnvelopes)
    .where(and(eq(signEnvelopes.id, id), eq(signEnvelopes.kind, 'template'), isNull(signEnvelopes.deletedAt)))
    .limit(1);
  if (!row) throw notFound('Template', id);
  return row;
}

/** The template in the editor's shape: an envelope detail of kind `template`. */
export async function getTemplateDetail(db: Database, template: SignEnvelope, canEdit: boolean): Promise<SignEnvelopeDetail> {
  const viewer: SignViewer = { userId: '', email: null, manageAll: false };
  const detail = await getEnvelopeDetail(db, template, { viewer, update: false, send: false, void: false });
  return { ...detail, canEdit, isOwner: false, canVoid: false, canRemind: false, mySignerId: null };
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export async function listTemplates(
  db: Database,
  opts: { search?: string; limit: number; offset: number },
): Promise<{ rows: SignTemplateSummary[]; total: number }> {
  const conditions: SQL[] = [eq(signEnvelopes.kind, 'template'), isNull(signEnvelopes.deletedAt)];
  if (opts.search) conditions.push(ilike(signEnvelopes.title, `%${escapeLike(opts.search)}%`));
  const where = and(...conditions);
  const [rows, [{ total }]] = await Promise.all([
    db.select().from(signEnvelopes).where(where).orderBy(desc(signEnvelopes.updatedAt), desc(signEnvelopes.id)).limit(opts.limit).offset(opts.offset),
    db.select({ total: count() }).from(signEnvelopes).where(where),
  ]);
  if (rows.length === 0) return { rows: [], total: Number(total) };

  const ids = rows.map((r) => r.id);
  const [docCounts, roles] = await Promise.all([
    db
      .select({ envelopeId: signDocuments.envelopeId, n: count() })
      .from(signDocuments)
      .where(inArray(signDocuments.envelopeId, ids))
      .groupBy(signDocuments.envelopeId),
    db
      .select()
      .from(signRecipients)
      .where(inArray(signRecipients.envelopeId, ids))
      .orderBy(asc(signRecipients.routingOrder), asc(signRecipients.createdAt)),
  ]);
  const docsBy = new Map(docCounts.map((d) => [d.envelopeId, Number(d.n)]));
  return {
    rows: rows.map((row) => ({
      id: row.id,
      title: row.title,
      documentCount: docsBy.get(row.id) ?? 0,
      roles: roles
        .filter((r) => r.envelopeId === row.id)
        .map((r) => ({ id: r.id, roleName: r.roleName ?? r.name ?? '', role: r.role })),
      createdByName: row.senderName,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    total: Number(total),
  };
}

export async function createTemplate(
  db: Database,
  input: CreateSignTemplateInput,
  creator: { userId: string; name: string | null; email: string | null },
  defaults: SignDefaults,
): Promise<SignEnvelope> {
  const [row] = await db
    .insert(signEnvelopes)
    .values({
      id: generateId('sgn'),
      kind: 'template',
      status: 'draft',
      title: input.title,
      message: input.message ?? null,
      // On a template the sender columns record who made it.
      senderUserId: creator.userId,
      senderName: creator.name,
      senderEmail: creator.email,
      reminderAfterDays: defaults.reminderAfterDays,
      reminderEveryDays: defaults.reminderEveryDays,
      reminderMaxCount: defaults.reminderMaxCount,
    })
    .returning();
  return row!;
}

/** Delete a template with its rows; returns the storage keys to remove. Requests made from it keep their own copies. */
export async function deleteTemplate(db: Database, template: SignEnvelope): Promise<string[]> {
  return deleteDraft(db, template);
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

async function assertRoleNameFree(db: Database, templateId: string, roleName: string, exceptId?: string): Promise<void> {
  const conditions = [eq(signRecipients.envelopeId, templateId), sql`lower(${signRecipients.roleName}) = ${roleName.toLowerCase()}`];
  if (exceptId) conditions.push(ne(signRecipients.id, exceptId));
  const [taken] = await db.select({ id: signRecipients.id }).from(signRecipients).where(and(...conditions)).limit(1);
  if (taken) throw invalid(`This template already has a role called ${roleName}`);
}

export async function addRole(db: Database, templateId: string, input: CreateSignTemplateRoleInput): Promise<SignRecipient> {
  const [{ existing, last }] = await db
    .select({ existing: count(), last: max(signRecipients.routingOrder) })
    .from(signRecipients)
    .where(eq(signRecipients.envelopeId, templateId));
  if (Number(existing) >= SIGN_LIMITS.maxRecipients) throw invalid(`A template can have at most ${SIGN_LIMITS.maxRecipients} roles`);
  await assertRoleNameFree(db, templateId, input.roleName);
  const [row] = await db
    .insert(signRecipients)
    .values({
      id: generateId('sgr'),
      envelopeId: templateId,
      role: input.role ?? 'signer',
      roleName: input.roleName,
      name: input.name ?? null,
      email: input.email ?? null,
      locale: input.locale ?? 'en',
      routingOrder: input.routingOrder ?? (last === null ? 1 : Number(last) + 1),
      // An access code is asked when the template is used; a template never holds one.
      // A copy role signs nothing, so it opens by link alone.
      authMode: input.role === 'cc' ? 'link' : (input.authMode ?? 'link'),
    })
    .returning();
  return row!;
}

export async function updateRole(db: Database, templateId: string, roleId: string, input: UpdateSignTemplateRoleInput): Promise<SignRecipient> {
  const current = await getRecipient(db, templateId, roleId);
  if (input.roleName !== undefined && input.roleName.toLowerCase() !== (current.roleName ?? '').toLowerCase()) {
    await assertRoleNameFree(db, templateId, input.roleName, roleId);
  }
  const role = input.role ?? current.role;
  const [row] = await db
    .update(signRecipients)
    .set({
      role,
      ...(input.roleName !== undefined && { roleName: input.roleName }),
      ...(input.name !== undefined && { name: input.name }),
      ...(input.email !== undefined && { email: input.email }),
      ...(input.locale !== undefined && { locale: input.locale }),
      ...(input.routingOrder !== undefined && { routingOrder: input.routingOrder }),
      ...(input.authMode !== undefined && { authMode: input.authMode }),
      // A copy role signs nothing, so it opens by link alone.
      ...(role === 'cc' && { authMode: 'link' as const }),
      updatedAt: new Date(),
    })
    .where(eq(signRecipients.id, roleId))
    .returning();
  // A copy role fills nothing in: drop any fields it had as a signer.
  if (role === 'cc' && current.role !== 'cc') await db.delete(signFields).where(eq(signFields.recipientId, roleId));
  return row!;
}

// ---------------------------------------------------------------------------
// Use
// ---------------------------------------------------------------------------

/** Who fills each role: every role exactly once, no stray roles, no address twice, codes where needed. */
function peopleByRole(roles: SignRecipient[], recipients: SignTemplateRecipientInput[]): Map<string, SignTemplateRecipientInput> {
  const byRole = new Map(recipients.map((r) => [r.roleId, r]));
  if (byRole.size !== recipients.length) throw invalid('Each role can be filled once');
  for (const roleId of byRole.keys()) {
    if (!roles.some((r) => r.id === roleId)) throw invalid(`Role ${roleId} is not part of this template`);
  }
  const emails = new Set<string>();
  for (const role of roles) {
    const person = byRole.get(role.id);
    if (!person) throw invalid(`Fill the role ${role.roleName}`);
    if (emails.has(person.email)) throw invalid(`${person.email} fills more than one role`);
    emails.add(person.email);
    if (authModeFor(role, person) === 'access_code' && !person.accessCode) {
      throw invalid(`${role.roleName} needs an access code`);
    }
  }
  return byRole;
}

/** A copy recipient signs nothing and opens the request by link alone. */
function authModeFor(role: SignRecipient, person: SignTemplateRecipientInput): SignRecipient['authMode'] {
  return role.role === 'cc' ? 'link' : (person.authMode ?? role.authMode);
}

export interface UseTemplateContext {
  db: Database;
  bucket: R2Bucket;
  /** Clerk org id, for the storage keys. */
  orgId: string;
  /** `SIGN_SESSION_SECRET`: keys access-code hashes. */
  secret?: string;
}

/** Copy a template's PDFs into a new draft's keys; returns the new document id per template document id. */
async function copyDocuments(ctx: UseTemplateContext, templateId: string, envelopeId: string, written: string[]): Promise<Map<string, string>> {
  const docs = await ctx.db.select().from(signDocuments).where(eq(signDocuments.envelopeId, templateId)).orderBy(asc(signDocuments.position));
  if (docs.length === 0) throw invalid('This template has no documents');
  const ids = new Map<string, string>();
  for (const doc of docs) {
    const object = await ctx.bucket.get(doc.storageKey);
    if (!object) throw new Error(`The file of template document ${doc.id} is missing`);
    const id = generateId('sgd');
    const storageKey = documentKey(ctx.orgId, envelopeId, id);
    await ctx.bucket.put(storageKey, await object.arrayBuffer(), {
      httpMetadata: { contentType: 'application/pdf' },
      customMetadata: { sha256: doc.sha256 },
    });
    written.push(storageKey);
    await ctx.db.insert(signDocuments).values({
      id,
      envelopeId,
      name: doc.name,
      position: doc.position,
      storageKey,
      sizeBytes: doc.sizeBytes,
      pageCount: doc.pageCount,
      pageSizes: doc.pageSizes,
      sha256: doc.sha256,
    });
    ids.set(doc.id, id);
  }
  return ids;
}

/**
 * A new draft request from a template, with a person in every role. Fails
 * as a whole: anything already written is removed again.
 */
export async function useTemplate(
  ctx: UseTemplateContext,
  template: SignEnvelope,
  input: UseSignTemplateInput,
  sender: { userId: string; name: string | null; email: string | null },
): Promise<SignEnvelope> {
  const { db } = ctx;
  const roles = await db
    .select()
    .from(signRecipients)
    .where(eq(signRecipients.envelopeId, template.id))
    .orderBy(asc(signRecipients.routingOrder), asc(signRecipients.createdAt));
  const people = peopleByRole(roles, input.recipients);

  const draft = await createEnvelope(db, {
    title: input.title ?? template.title,
    message: input.message === undefined ? template.message : input.message,
    sender,
  });
  const written: string[] = [];
  try {
    await db
      .update(signEnvelopes)
      .set({
        templateId: template.id,
        signingOrderEnabled: template.signingOrderEnabled,
        reminderAfterDays: template.reminderAfterDays,
        reminderEveryDays: template.reminderEveryDays,
        reminderMaxCount: template.reminderMaxCount,
      })
      .where(eq(signEnvelopes.id, draft.id));
    const documentIds = await copyDocuments(ctx, template.id, draft.id, written);

    const recipientIds = new Map<string, string>();
    for (const role of roles) {
      const person = people.get(role.id)!;
      const recipient = await addRecipient(
        db,
        draft.id,
        {
          role: role.role,
          roleName: role.roleName,
          name: person.name,
          email: person.email,
          personId: person.personId,
          locale: person.locale ?? (role.locale === 'nl' ? 'nl' : 'en'),
          routingOrder: role.routingOrder,
          authMode: authModeFor(role, person),
          accessCode: role.role === 'cc' ? null : person.accessCode,
        },
        'en',
        ctx.secret,
      );
      recipientIds.set(role.id, recipient.id);
    }

    const fields = await db.select().from(signFields).where(eq(signFields.envelopeId, template.id)).orderBy(asc(signFields.createdAt));
    if (fields.length > 0) {
      await db.insert(signFields).values(
        fields.map((f) => ({
          id: generateId('sgf'),
          envelopeId: draft.id,
          documentId: documentIds.get(f.documentId)!,
          recipientId: recipientIds.get(f.recipientId)!,
          type: f.type,
          page: f.page,
          x: f.x,
          y: f.y,
          width: f.width,
          height: f.height,
          required: f.required,
          label: f.label,
        })),
      );
    }
  } catch (err) {
    // Leave nothing half made: the draft, its rows and the files copied so far.
    await deleteDraft(db, draft).catch(() => undefined);
    if (written.length) await ctx.bucket.delete(written).catch(() => undefined);
    throw err;
  }
  const [row] = await db.select().from(signEnvelopes).where(eq(signEnvelopes.id, draft.id)).limit(1);
  return row!;
}
