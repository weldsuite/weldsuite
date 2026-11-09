/**
 * ProcessResponse step: WeldDesk (ADR FORMS-006, DESK-008). Per enabled `desk`
 * integration, as the member who set it up: a conversation (the ticket) in the
 * inbox with a subject and body from recall templates, the respondent as
 * requester, a priority and tags, in a department (the workspace's routing
 * rules decide when none is chosen), and the response's uploads attached.
 *
 * Written through `@weldsuite/desk-domain/inbox`, the writer every module
 * outside the inbox uses: auto-assignment, the team notification and the
 * `desk_conversation` events follow as for any other ticket. The conversation's
 * external id is `form-response:<responseId>:<integrationId>`, so a retry lands
 * on the ticket it made instead of opening a second one, and an edit of the
 * response leaves it as it is.
 */

import { openDeskApiConversation, DeskAttributeRejectedError } from '@weldsuite/desk-domain/inbox';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { generateId } from '@weldsuite/worker-kit/id';
import { deskIntegrationConfigSchema } from '@weldsuite/app-api-client/schemas/weldforms';
import { findField } from '@weldsuite/forms-engine';
import { CreatorForbiddenError, loadCreatorAccess } from '../../services/creator-access';
import {
  answerLines,
  answerText,
  emailAnswer,
  readResponseFile,
  recordedEntity,
  rememberEntity,
  renderTemplate,
  safeFileName,
} from '../../services/integration-support';
import type { IntegrationStep, ProcessContext, StepResult } from './types';

type Integration = Parameters<IntegrationStep['run']>[1];
type Attachment = { name: string; url: string; contentType: string; filesize: number };

const PRIORITY = { low: 'low', normal: 'medium', high: 'high', urgent: 'urgent' } as const;

/** Types the inbox may serve inline from the public bucket; anything else is stored as a download. */
const PASSIVE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

/** Copies the response's uploads to the public bucket (unguessable path) and returns them in the desk message shape. */
async function copyAttachments(ctx: ProcessContext): Promise<Attachment[]> {
  const base = ctx.env.R2_PUBLIC_URL?.trim().replace(/\/+$/, '');
  if (!base || ctx.files.length === 0) return [];
  const out: Attachment[] = [];
  for (const file of ctx.files.slice(0, 10)) {
    const body = await readResponseFile(ctx.env, file);
    if (!body) continue;
    const type = file.contentType.split(';')[0]!.trim().toLowerCase();
    const passive = PASSIVE_TYPES.has(type);
    const name = safeFileName(file.name);
    const key = `desk/${ctx.params.clerkOrgId}/forms/${ctx.response.id}/${crypto.randomUUID()}/${name}`;
    await ctx.env.STORAGE.put(key, body, {
      httpMetadata: {
        contentType: passive ? type : 'application/octet-stream',
        contentDisposition: passive ? `inline; filename="${name}"` : `attachment; filename="${name}"`,
      },
    });
    out.push({ name: file.name, url: `${base}/${key}`, contentType: passive ? type : 'application/octet-stream', filesize: file.sizeBytes });
  }
  return out;
}

/** The requester: the chosen email question (and the name from a contact question), else the verified email. */
function requesterOf(ctx: ProcessContext, requesterFieldId: string | undefined): { email: string | null; name: string | null } {
  const email = (requesterFieldId ? emailAnswer(ctx.definition, ctx.response, requesterFieldId) : '') || ctx.response.respondentEmail || null;
  let name: string | null = null;
  if (requesterFieldId && findField(ctx.definition, requesterFieldId)?.type === 'contact_info') {
    name = [answerText(ctx.definition, ctx.response, requesterFieldId, 'firstName'), answerText(ctx.definition, ctx.response, requesterFieldId, 'lastName')].filter(Boolean).join(' ') || null;
  }
  return { email, name };
}

export async function runDeskStep(ctx: ProcessContext, integration: Integration): Promise<StepResult> {
  const parsed = deskIntegrationConfigSchema.safeParse(integration.config);
  if (!parsed.success) return { status: 'skipped', reason: 'The Desk integration is not set up correctly' };
  const config = parsed.data;

  try {
    const recorded = await recordedEntity(ctx.db, ctx, integration);
    // A ticket this integration already opened for the response stays as the team found it: a retry or an edit adds nothing.
    if (recorded?.entityType === 'desk_conversation') {
      return { status: 'done', entityType: recorded.entityType, entityId: recorded.entityId };
    }
    const access = await loadCreatorAccess(ctx.db, ctx.env, integration.createdByUserId);
    access.require('tickets:create', 'welddesk', 'open tickets');

    const template = { env: ctx.env, form: ctx.form, response: ctx.response, definition: ctx.definition };
    const title = renderTemplate(config.subject, template).trim() || `${ctx.form.title} #${ctx.response.number ?? ''}`.trim();
    const body = (config.body.trim() ? renderTemplate(config.body, template) : answerLines(ctx.definition, ctx.response)).trim() || title;
    const requester = requesterOf(ctx, config.requesterFieldId);
    const attachments = config.attachFiles ? await copyAttachments(ctx) : [];

    const result = await openDeskApiConversation(
      {
        db: ctx.db,
        env: ctx.env as never,
        clerkOrgId: ctx.params.clerkOrgId,
        generateId,
        emit: async (event) => {
          await publishEntityEventRaw({
            env: ctx.env,
            workspaceId: ctx.params.clerkOrgId,
            userId: integration.createdByUserId,
            entityType: event.entityType,
            action: event.action as never,
            entityId: event.entityId,
            data: event.data as never,
            source: 'api',
          });
        },
      },
      {
        via: 'api',
        externalId: `form-response:${ctx.response.id}:${integration.id}`,
        title: title.slice(0, 255),
        body,
        name: requester.name ?? requester.email ?? ctx.form.title,
        email: requester.email,
        attachments: attachments.length ? attachments : undefined,
        metadata: { formId: ctx.form.id, responseId: ctx.response.id, integrationId: integration.id },
        fields: {
          priority: PRIORITY[config.priority],
          ...(config.tags.length ? { tags: config.tags } : {}),
          ...(config.departmentId ? { departmentId: config.departmentId } : {}),
        },
        actor: { authorType: 'bot', authorId: integration.id },
      },
    );
    await rememberEntity(ctx.db, ctx, integration, 'desk_conversation', result.conversation.id);
    return { status: 'done', entityType: 'desk_conversation', entityId: result.conversation.id };
  } catch (err) {
    if (err instanceof CreatorForbiddenError) return { status: 'skipped', reason: err.message };
    // A department that was removed or switched off: a retry cannot fix it, the author must.
    if (err instanceof DeskAttributeRejectedError) return { status: 'skipped', reason: err.message };
    throw err;
  }
}

export const deskStep: IntegrationStep = { type: 'integration', kind: 'desk', name: 'desk', run: runDeskStep };
