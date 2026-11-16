/**
 * Members-only forms — /api/forms/fill/:publicId, answered inside the platform
 * (weldsuite-documentation/plans/weldforms.md, "Respondent modes").
 *
 *   GET  /:publicId   → the form (same payload as the public one, no bot check) and whether
 *                       the member already responded
 *   POST /:publicId/uploads → a file or signature for one field, bound to the member's in-progress
 *                       response (created by the first upload; the submit then completes it)
 *   POST /:publicId   → submit: the same validation path as the public submit, the response
 *                       tied to the member, or to a keyed hash when the form hides identities
 *
 * No `forms:*` permission gates it: whoever is a member of the workspace may
 * answer a form addressed to the workspace (a pulse survey must not need every
 * role to hold `forms:read`). The form's respondent mode is the gate: any other
 * form is a 404 here. A public id of another workspace is a 404 too.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { success } from '@weldsuite/worker-kit/response';
import { memberSubmitSchema } from '@weldsuite/app-api-client/schemas/weldforms';
import { FormsError, handle, notFound } from '../../lib/errors';
import { workspaceCtx, type WorkspaceCtx } from '../../services/context';
import { loadEntry, loadVersion, resolveLink, stateOf, toPublicForm, closedError, type LinkRow } from '../../services/public-form';
import type { PublicCacheEntry } from '../../services/public-cache';
import { keyedHash } from '../../services/sessions';
import { submitResponse, type SubmitIdentity } from '../../services/submit';
import { uploadFile } from '../../services/respondent';
import { countersFor } from '../../lib/counters';
import { memberRef } from '../../services/members';
import type { Env, Variables } from '../../types';

const { forms, formResponses } = schema;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/** The form behind a public id, if it is a members-only form of this workspace. */
async function membersForm(ctx: WorkspaceCtx, publicId: string): Promise<{ link: LinkRow; entry: PublicCacheEntry }> {
  const link = await resolveLink(ctx.master, publicId);
  if (link.workspaceId !== ctx.workspaceId) throw notFound('Form');
  const { entry } = await loadEntry(ctx.env, link, ctx);
  if (entry.settings.respondentMode !== 'members') throw notFound('Form');
  return { link, entry };
}

/** How this member is told apart from the others: their id, or a keyed hash when the form hides identities. */
async function identityOf(ctx: WorkspaceCtx, entry: PublicCacheEntry, userId: string): Promise<SubmitIdentity> {
  if (entry.settings.hideMemberIdentity) {
    return { email: null, userId: null, hash: await keyedHash(ctx.env, `member:${entry.formId}`, userId), invitationId: null };
  }
  const profile = await memberRef(ctx.db, userId);
  return { email: profile.email?.toLowerCase() ?? null, userId, hash: null, invitationId: null };
}

/** The member's unfinished response on this form (made by their first upload), if they have one. */
async function memberInProgress(ctx: WorkspaceCtx, formId: string, identity: SubmitIdentity): Promise<{ id: string; versionId: string } | undefined> {
  const same = identity.hash ? eq(formResponses.respondentHash, identity.hash) : eq(formResponses.respondentUserId, identity.userId ?? '');
  const [row] = await ctx.db
    .select({ id: formResponses.id, versionId: formResponses.versionId })
    .from(formResponses)
    .where(and(eq(formResponses.formId, formId), eq(formResponses.status, 'in_progress'), same))
    .orderBy(desc(formResponses.updatedAt))
    .limit(1);
  return row;
}

app.get('/:publicId', (c) =>
  handle(c, async () => {
    const ctx = workspaceCtx(c);
    const { link, entry } = await membersForm(ctx, c.req.param('publicId'));
    let alreadyResponded = false;
    if (entry.settings.onePerRespondent) {
      const who = await identityOf(ctx, entry, c.get('userId'));
      const same = who.hash ? eq(formResponses.respondentHash, who.hash) : eq(formResponses.respondentUserId, who.userId ?? '');
      const [row] = await ctx.db
        .select({ id: formResponses.id })
        .from(formResponses)
        .where(and(eq(formResponses.formId, link.formId), eq(formResponses.status, 'completed'), same))
        .limit(1);
      alreadyResponded = Boolean(row);
    }
    return success(c, { form: toPublicForm(c.env, link, entry, { inPlatform: true }), alreadyResponded });
  }),
);

app.post('/:publicId/uploads', (c) =>
  handle(c, async () => {
    const ctx = workspaceCtx(c);
    const { link, entry } = await membersForm(ctx, c.req.param('publicId'));
    const state = stateOf(link, entry);
    if (state !== 'open' || !entry.versionId) throw closedError(state === 'open' ? 'closed' : state);
    let body: FormData;
    try {
      body = await c.req.formData();
    } catch {
      throw new FormsError(400, 'BAD_REQUEST', 'Send the file as multipart form data.');
    }
    const blockId = body.get('blockId');
    const file = body.get('file');
    if (typeof blockId !== 'string' || !file || typeof file === 'string') throw new FormsError(400, 'BAD_REQUEST', 'Send "blockId" and "file".');

    const identity = await identityOf(ctx, entry, c.get('userId'));
    let response = await memberInProgress(ctx, link.formId, identity);
    if (!response) {
      const [created] = await ctx.db
        .insert(formResponses)
        .values({
          id: generateId('frs'),
          formId: link.formId,
          versionId: entry.versionId,
          status: 'in_progress',
          respondentEmail: identity.email,
          respondentUserId: identity.userId,
          respondentHash: identity.hash,
          metadata: { source: 'members' },
        })
        .returning({ id: formResponses.id, versionId: formResponses.versionId });
      response = created!;
    }
    const counters = countersFor(c.env.FORM_COUNTERS, link.formId);
    const uploaded = await uploadFile({ env: c.env, ctx, session: { resp: response.id, form: link.formId, ver: entry.versionId }, counters, blockId, file });
    return success(c, { file: uploaded }, 201);
  }),
);

app.post('/:publicId', zValidator('json', memberSubmitSchema), (c) =>
  handle(c, async () => {
    const ctx = workspaceCtx(c);
    const userId = c.get('userId');
    const { link, entry } = await membersForm(ctx, c.req.param('publicId'));
    const state = stateOf(link, entry);
    if (state !== 'open' || !entry.versionId) throw closedError(state === 'open' ? 'closed' : state);

    const [form] = await ctx.db.select().from(forms).where(eq(forms.id, link.formId)).limit(1);
    if (!form) throw new FormsError(404, 'NOT_FOUND', 'Form not found');
    const input = c.req.valid('json');
    const identity = await identityOf(ctx, entry, userId);
    const outcome = await submitResponse({
      ctx,
      form,
      version: await loadVersion(ctx, form.id, entry.versionId),
      responseId: (await memberInProgress(ctx, link.formId, identity))?.id ?? generateId('frs'),
      answers: input.answers,
      hidden: input.hidden ?? {},
      timings: input.timings,
      identity,
      seed: { metadata: { source: 'members' }, ipHash: null, startedAt: Date.now() },
      // A form that hides identities must not name the member in the audit trail either.
      actor: entry.settings.hideMemberIdentity ? 'respondent' : userId,
      waitUntil: (p) => c.executionCtx.waitUntil(p),
    });
    return success(c, outcome.result, 201);
  }),
);

export default app;
