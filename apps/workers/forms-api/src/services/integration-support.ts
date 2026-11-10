/**
 * What the integration steps (CRM, Desk, Flow) share: recall templates with the
 * integration-only tokens, one answer as text, the link to a response, the
 * record a step made (kept on its action row so a retry reuses it), and
 * copying a response's uploads to where the target module can open them.
 */

import { and, eq } from 'drizzle-orm';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { displayAnswer, fieldsOf, findField, isCompositeField, ownValue, prepareAnswer, recall } from '@weldsuite/forms-engine';
import type { FormDefinition } from '@weldsuite/forms-engine/definition';
import type { Env } from '../types';
import type { ProcessContext } from '../workflows/steps/types';

type FormRow = typeof schema.forms.$inferSelect;
type ResponseRow = typeof schema.formResponses.$inferSelect;
type IntegrationRow = typeof schema.formIntegrations.$inferSelect;
type FileRow = typeof schema.formResponseFiles.$inferSelect;

const { formResponseActions } = schema;

/** The member-side page of one response (`<PLATFORM_URL>/weldforms/<formId>/results?...`). */
export function responseUrl(env: Pick<Env, 'PLATFORM_URL'>, formId: string, responseId: string): string {
  const base = (env.PLATFORM_URL || 'https://app.weldsuite.org').replace(/\/$/, '');
  return `${base}/weldforms/${formId}/results?tab=responses&response=${responseId}`;
}

/** What a template can recall: the engine's tokens over the response, plus `{{form:title}}`, `{{response:number}}`, `{{response:url}}`. */
export interface TemplateContext {
  env: Pick<Env, 'PLATFORM_URL'>;
  form: Pick<FormRow, 'id' | 'title'>;
  response: Pick<ResponseRow, 'id' | 'number' | 'answers' | 'hidden' | 'variables'>;
  definition: FormDefinition;
}

const EXTRA_TOKEN_RE = /\{\{\s*(form:title|response:number|response:url)\s*\}\}/g;

export function renderTemplate(text: string, ctx: TemplateContext): string {
  const withExtras = text.replace(EXTRA_TOKEN_RE, (_m, token: string) => {
    if (token === 'form:title') return ctx.form.title;
    if (token === 'response:number') return ctx.response.number === null ? '' : String(ctx.response.number);
    return responseUrl(ctx.env, ctx.form.id, ctx.response.id);
  });
  return recall(withExtras, ctx.definition, {
    answers: ctx.response.answers as never,
    hidden: ctx.response.hidden,
    variables: ctx.response.variables,
  });
}

/**
 * The text of one answer; for a contact or address question, of one `part`
 * (`email`, `firstName`, ...). Empty when unanswered or the question is gone.
 */
export function answerText(definition: FormDefinition, response: Pick<ResponseRow, 'answers'>, blockId: string, part?: string): string {
  const field = findField(definition, blockId);
  if (!field) return '';
  const raw = ownValue(response.answers, field.id);
  if (part && isCompositeField(field)) {
    const prepared = prepareAnswer(field, raw);
    if (prepared.kind !== 'value') return '';
    const value = (prepared.value as Record<string, unknown>)[part];
    return typeof value === 'string' ? value.trim() : '';
  }
  return displayAnswer(field, raw).trim();
}

/** The email of a response through an email or contact-info question. */
export function emailAnswer(definition: FormDefinition, response: Pick<ResponseRow, 'answers'>, blockId: string): string {
  const field = findField(definition, blockId);
  if (!field) return '';
  const value = field.type === 'contact_info' ? answerText(definition, response, blockId, 'email') : answerText(definition, response, blockId);
  return value.toLowerCase();
}

/** Every answered question as "Question: answer" lines, without the ones marked sensitive and the files. */
export function answerLines(definition: FormDefinition, response: Pick<ResponseRow, 'answers'>): string {
  const lines: string[] = [];
  for (const field of fieldsOf(definition)) {
    if (field.sensitive || field.type === 'file_upload' || field.type === 'signature') continue;
    const text = displayAnswer(field, ownValue(response.answers, field.id)).trim();
    if (text) lines.push(`${field.title}: ${text}`);
  }
  return lines.join('\n');
}

// ── The record a step made ───────────────────────────────────────────────────

/** The record an earlier attempt of this step already made (and recorded), or null. */
export async function recordedEntity(
  db: Database,
  ctx: Pick<ProcessContext, 'response'>,
  integration: Pick<IntegrationRow, 'id'>,
): Promise<{ entityType: string; entityId: string } | null> {
  const [row] = await db
    .select({ entityType: formResponseActions.entityType, entityId: formResponseActions.entityId })
    .from(formResponseActions)
    .where(and(eq(formResponseActions.responseId, ctx.response.id), eq(formResponseActions.integrationId, integration.id)))
    .limit(1);
  return row?.entityType && row.entityId ? { entityType: row.entityType, entityId: row.entityId } : null;
}

/**
 * Remembers the record on the action row right away, before the step's later
 * parts: a failure after the record exists retries into the same record
 * instead of making a second one.
 */
export async function rememberEntity(
  db: Database,
  ctx: Pick<ProcessContext, 'response'>,
  integration: Pick<IntegrationRow, 'id'>,
  entityType: string,
  entityId: string,
): Promise<void> {
  await db
    .update(formResponseActions)
    .set({ entityType, entityId })
    .where(and(eq(formResponseActions.responseId, ctx.response.id), eq(formResponseActions.integrationId, integration.id)));
}

/** Publishes an entity event for a record a step made, as the integration's creator. */
export async function emitRecordEvent(
  ctx: Pick<ProcessContext, 'env' | 'params'>,
  integration: Pick<IntegrationRow, 'createdByUserId'>,
  entityType: string,
  action: 'created' | 'updated',
  entityId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await publishEntityEventRaw({
    env: ctx.env,
    workspaceId: ctx.params.clerkOrgId,
    userId: integration.createdByUserId,
    entityType: entityType as never,
    action: action as never,
    entityId,
    data: data as never,
    source: 'api',
  });
}

// ── Uploads ──────────────────────────────────────────────────────────────────

/** Characters a stored file name may keep. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned.slice(-120) || 'file';
}

/** The response's uploads (and signature images), as the response recorded them. */
export function uploadsOf(ctx: Pick<ProcessContext, 'files'>): FileRow[] {
  return ctx.files;
}

/** A response file read from the private bucket; null when the object is gone. */
export async function readResponseFile(env: Pick<Env, 'PRIVATE_STORAGE'>, file: FileRow): Promise<ArrayBuffer | null> {
  const object = await env.PRIVATE_STORAGE.get(file.storageKey);
  return object ? await object.arrayBuffer() : null;
}
