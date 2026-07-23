/**
 * Mail AI service.
 *
 * Rebuilt on `@weldsuite/ai` (Cloudflare AI Gateway) after the agent-worker
 * teardown. Each function enriches the request with tenant-DB context (account
 * aiSettings, message bodies), builds a prompt, and calls the model directly.
 *
 * Model tiers (balanced): customer-facing *writing* (draft / reply /
 * improve-text / auto-draft) defaults to a premium model; *summary /
 * smart-replies / classification* defaults to a free Workers AI model. A
 * per-account `aiSettings.modelPreference` (or an explicit `modelId`) always
 * wins. No per-call credit metering — billing is handled by Cloudflare.
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  assertGatewayConfigured,
  createWeldAI,
  generateObject,
  generateText,
  jsonSchema,
  recommended,
  thirdParty,
  type WeldAI,
} from '@weldsuite/ai';
import { schema } from '../../db';
import type { Database } from '../../db';
import type { Env } from '../../types';
import { assertAiCredits, chargeAiUsage, type AiMetering } from '../ai/billing';

const { mailAccounts, mailMessages } = schema;

export class MailAiError extends Error {
  constructor(
    public readonly code:
      | 'ACCOUNT_NOT_FOUND'
      | 'MESSAGE_NOT_FOUND'
      | 'AI_NOT_CONFIGURED'
      | 'AI_REQUEST_FAILED',
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'MailAiError';
  }
}

export type MailAiOp =
  | 'draft'
  | 'improve-text'
  | 'auto-draft'
  | 'reply'
  | 'label'
  | 'label-batch'
  | 'inbox-summary'
  | 'smart-replies';

/** Balanced defaults — see file header. Per-account/explicit ids override. */
const MODEL_DEFAULTS: Record<MailAiOp, string> = {
  draft: thirdParty.anthropic.sonnet,
  'improve-text': thirdParty.anthropic.sonnet,
  'auto-draft': thirdParty.anthropic.sonnet,
  reply: thirdParty.anthropic.sonnet,
  'smart-replies': recommended.draft.free,
  'inbox-summary': recommended.summarize.free,
  label: recommended.classify.free,
  'label-batch': recommended.classify.free,
};

const CLASSIFY_CATEGORIES = [
  'sales',
  'support',
  'billing',
  'personal',
  'newsletter',
  'notification',
  'spam',
  'other',
] as const;
const PRIORITIES = ['high', 'normal', 'low'] as const;

// JSON schemas (not zod) for structured output — zod v3 schemas trip TS2589
// "excessively deep" against the AI SDK v7 generics; jsonSchema<T> keeps the
// output type explicit and the inference shallow.
const emailSchema = jsonSchema<{ subject: string; body: string }>({
  type: 'object',
  properties: { subject: { type: 'string' }, body: { type: 'string' } },
  required: ['subject', 'body'],
  additionalProperties: false,
});

const repliesSchema = jsonSchema<{ replies: string[] }>({
  type: 'object',
  properties: { replies: { type: 'array', items: { type: 'string' }, maxItems: 3 } },
  required: ['replies'],
  additionalProperties: false,
});

const classifySchema = jsonSchema<{ category: string; priority: string }>({
  type: 'object',
  properties: {
    category: { type: 'string', enum: [...CLASSIFY_CATEGORIES] },
    priority: { type: 'string', enum: [...PRIORITIES] },
  },
  required: ['category', 'priority'],
  additionalProperties: false,
});

// ---------------------------------------------------------------------------
// Context loaders
// ---------------------------------------------------------------------------

interface AccountContext {
  aiSettings: {
    customInstructions?: string;
    defaultTone?: 'professional' | 'friendly' | 'casual';
    defaultLength?: 'short' | 'medium' | 'long';
    modelPreference?: string;
  } | null;
  displayName: string | null;
}

async function loadAccountContext(
  db: Database,
  accountId: string,
): Promise<AccountContext | null> {
  const [row] = await db
    .select({
      aiSettings: mailAccounts.aiSettings,
      displayName: mailAccounts.displayName,
    })
    .from(mailAccounts)
    .where(and(eq(mailAccounts.id, accountId), isNull(mailAccounts.deletedAt)))
    .limit(1);
  if (!row) return null;
  return {
    aiSettings: (row.aiSettings as AccountContext['aiSettings']) ?? null,
    displayName: row.displayName ?? null,
  };
}

async function loadMessage(db: Database, messageId: string) {
  const [row] = await db
    .select()
    .from(mailMessages)
    .where(and(eq(mailMessages.id, messageId), isNull(mailMessages.deletedAt)))
    .limit(1);
  return row ?? null;
}

type LoadedMessage = NonNullable<Awaited<ReturnType<typeof loadMessage>>>;

async function loadRecentMessages(
  db: Database,
  accountId: string | undefined,
  limit = 15,
) {
  const conds = [isNull(mailMessages.deletedAt), eq(mailMessages.isTrash, false)];
  if (accountId) conds.push(eq(mailMessages.accountId, accountId));
  return db
    .select({
      id: mailMessages.id,
      subject: mailMessages.subject,
      from: mailMessages.from,
      preview: mailMessages.preview,
      sentDate: mailMessages.sentDate,
      isRead: mailMessages.isRead,
    })
    .from(mailMessages)
    .where(and(...conds))
    .orderBy(desc(mailMessages.sentDate))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

function getAi(env: Env): WeldAI {
  // Delegate to @weldsuite/ai: it validates the Cloudflare AI Gateway env.
  try {
    assertGatewayConfigured(env);
  } catch (err) {
    throw new MailAiError(
      'AI_NOT_CONFIGURED',
      err instanceof Error ? err.message : 'AI gateway is not configured',
      503,
    );
  }
  return createWeldAI(env);
}

function pickModel(
  op: MailAiOp,
  accountCtx: AccountContext | null,
  explicit?: string | null,
): string {
  return explicit || accountCtx?.aiSettings?.modelPreference || MODEL_DEFAULTS[op];
}

function baseSystem(accountCtx: AccountContext | null, role: string): string {
  const parts = [role];
  if (accountCtx?.displayName) {
    parts.push(`You are writing on behalf of ${accountCtx.displayName}.`);
  }
  if (accountCtx?.aiSettings?.customInstructions) {
    parts.push(`Always follow these instructions: ${accountCtx.aiSettings.customInstructions}`);
  }
  parts.push('Write plain text only — no markdown, and no preamble like "Here is your email".');
  return parts.join('\n');
}

function toneLine(tone?: string): string {
  switch (tone) {
    case 'friendly':
      return 'Tone: warm and friendly.';
    case 'casual':
      return 'Tone: casual and conversational.';
    case 'brief':
      return 'Tone: brief and direct.';
    default:
      return 'Tone: professional and polished.';
  }
}

function lengthLine(length?: string): string {
  switch (length) {
    case 'short':
      return 'Length: 1–2 short paragraphs.';
    case 'long':
      return 'Length: thorough and detailed.';
    default:
      return 'Length: a few concise paragraphs.';
  }
}

function messageContext(m: LoadedMessage): string {
  const fromName = m.from?.name ?? '';
  const fromEmail = m.from?.email ?? '';
  const body = (m.textBody || m.preview || '').slice(0, 6000);
  return `From: ${fromName} <${fromEmail}>\nSubject: ${m.subject ?? '(no subject)'}\n\n${body}`;
}

/** Run a text generation and charge the wallet for the tokens used. */
async function meteredText(
  metering: AiMetering | null,
  ai: WeldAI,
  model: string,
  op: string,
  system: string,
  prompt: string,
): Promise<string> {
  const res = await guard(() => generateText({ model: ai.model(model), system, prompt }));
  await chargeAiUsage(metering, { modelId: model, usage: res.usage, op });
  return res.text.trim();
}

/**
 * Wrap an AI SDK call so any failure surfaces as a `MailAiError`. Kept
 * non-generic over the schema (callers inline a concrete schema) so the AI
 * SDK's `generateObject` inference stays bounded — a generic schema param
 * trips TS2589 "excessively deep" under this repo's zod types.
 */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new MailAiError(
      'AI_REQUEST_FAILED',
      err instanceof Error ? err.message : 'AI request failed',
      502,
    );
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface DraftInput {
  prompt: string;
  replyToMessageId?: string | null;
  accountId?: string | null;
  tone?: 'professional' | 'friendly' | 'casual';
  length?: 'short' | 'medium' | 'long';
  modelId?: string | null;
}

export async function draftEmail(
  env: Env,
  db: Database,
  input: DraftInput,
  metering: AiMetering | null,
) {
  const accountCtx = input.accountId ? await loadAccountContext(db, input.accountId) : null;
  const replyTo = input.replyToMessageId ? await loadMessage(db, input.replyToMessageId) : null;
  if (input.replyToMessageId && !replyTo) {
    throw new MailAiError('MESSAGE_NOT_FOUND', 'Original message not found', 404);
  }
  const ai = getAi(env);
  await assertAiCredits(metering);
  const model = pickModel('draft', accountCtx, input.modelId);
  const tone = input.tone ?? accountCtx?.aiSettings?.defaultTone;
  const length = input.length ?? accountCtx?.aiSettings?.defaultLength;

  const res = await guard(() =>
    generateObject({
      model: ai.model(model),
      schema: emailSchema,
      system: baseSystem(
        accountCtx,
        'You are an expert email-writing assistant. Write a complete, ready-to-send email.',
      ),
      prompt: [
        toneLine(tone),
        lengthLine(length),
        replyTo ? `You are drafting a reply to this email:\n\n${messageContext(replyTo)}\n` : '',
        `Write an email that: ${input.prompt}`,
        'Return a concise subject line and the email body.',
      ]
        .filter(Boolean)
        .join('\n'),
    }),
  );
  await chargeAiUsage(metering, { modelId: model, usage: res.usage, op: 'draft' });
  return { subject: res.object.subject, body: res.object.body };
}

export interface ImproveTextInput {
  text: string;
  action: 'improve' | 'shorten' | 'expand' | 'formalize' | 'make_friendly';
  accountId?: string | null;
  modelId?: string | null;
}

const IMPROVE_INSTRUCTIONS: Record<ImproveTextInput['action'], string> = {
  improve:
    'Improve the clarity, grammar, and flow of the text while preserving its meaning and intent.',
  shorten: 'Make the text more concise without losing its key points.',
  expand: 'Expand the text with more detail and helpful context.',
  formalize: 'Rewrite the text in a more formal, professional tone.',
  make_friendly: 'Rewrite the text in a warmer, friendlier tone.',
};

export async function improveText(
  env: Env,
  db: Database,
  input: ImproveTextInput,
  metering: AiMetering | null,
) {
  const accountCtx = input.accountId ? await loadAccountContext(db, input.accountId) : null;
  const ai = getAi(env);
  await assertAiCredits(metering);
  const model = pickModel('improve-text', accountCtx, input.modelId);
  const text = await meteredText(
    metering,
    ai,
    model,
    'improve-text',
    baseSystem(accountCtx, 'You are an expert editor for email. Return only the rewritten text.'),
    `${IMPROVE_INSTRUCTIONS[input.action]}\n\nText:\n${input.text}`,
  );
  return { text };
}

export interface AutoDraftInput {
  accountId: string;
  /** When set, draft a reply to this specific message. */
  messageId?: string | null;
  prompt?: string;
  recentMessageIds?: string[];
  modelId?: string | null;
}

export async function autoDraft(
  env: Env,
  db: Database,
  input: AutoDraftInput,
  metering: AiMetering | null,
) {
  const accountCtx = await loadAccountContext(db, input.accountId);
  if (!accountCtx) throw new MailAiError('ACCOUNT_NOT_FOUND', 'Mail account not found', 404);

  // Primary context: an explicit message to reply to, else recent inbox.
  const replyTo = input.messageId ? await loadMessage(db, input.messageId) : null;
  const recent = replyTo
    ? []
    : input.recentMessageIds && input.recentMessageIds.length > 0
      ? (
          await Promise.all(input.recentMessageIds.slice(0, 20).map((id) => loadMessage(db, id)))
        ).filter((m): m is LoadedMessage => Boolean(m))
      : await loadRecentMessages(db, input.accountId, 8);

  const digest = recent
    .map((m) => `- ${m.from?.email ?? ''}: ${m.subject ?? '(no subject)'} — ${m.preview ?? ''}`)
    .join('\n');

  const ai = getAi(env);
  await assertAiCredits(metering);
  const model = pickModel('auto-draft', accountCtx, input.modelId);
  const res = await guard(() =>
    generateObject({
      model: ai.model(model),
      schema: emailSchema,
      system: baseSystem(
        accountCtx,
        replyTo
          ? 'You are an email-writing assistant. Draft a reply to the email below.'
          : 'You are an email-writing assistant. Draft a useful email the user is likely to want to send next.',
      ),
      prompt: [
        toneLine(accountCtx.aiSettings?.defaultTone),
        lengthLine(accountCtx.aiSettings?.defaultLength),
        replyTo ? `Reply to this email:\n\n${messageContext(replyTo)}\n` : '',
        digest ? `Recent inbox context:\n${digest}\n` : '',
        input.prompt
          ? `The user's intent: ${input.prompt}`
          : replyTo
            ? 'Write an appropriate reply.'
            : 'Suggest a helpful follow-up email based on the context.',
        'Return a subject line and the email body.',
      ]
        .filter(Boolean)
        .join('\n'),
    }),
  );
  await chargeAiUsage(metering, { modelId: model, usage: res.usage, op: 'auto-draft' });
  return { subject: res.object.subject, body: res.object.body };
}

export interface ReplyInput {
  messageId?: string | null;
  userPrompt?: string;
  accountId?: string | null;
  tone?: 'professional' | 'friendly' | 'brief';
  modelId?: string | null;
}

export async function replySuggestion(
  env: Env,
  db: Database,
  input: ReplyInput,
  metering: AiMetering | null,
) {
  let message: LoadedMessage | null = null;
  if (input.messageId) {
    message = await loadMessage(db, input.messageId);
    if (!message) throw new MailAiError('MESSAGE_NOT_FOUND', 'Message not found', 404);
  }
  const accountIdForCtx = input.accountId ?? message?.accountId;
  const accountCtx = accountIdForCtx ? await loadAccountContext(db, accountIdForCtx) : null;

  const ai = getAi(env);
  await assertAiCredits(metering);
  const model = pickModel('reply', accountCtx, input.modelId);
  const body = await meteredText(
    metering,
    ai,
    model,
    'reply',
    baseSystem(accountCtx, 'You are an email-writing assistant. Write a reply body only (no subject line).'),
    [
      toneLine(input.tone ?? accountCtx?.aiSettings?.defaultTone),
      message ? `Reply to this email:\n\n${messageContext(message)}\n` : '',
      input.userPrompt ? `The reply should: ${input.userPrompt}` : 'Write an appropriate reply.',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return { body };
}

export interface InboxSummaryInput {
  accountId?: string | null;
  modelId?: string | null;
}

export async function inboxSummary(
  env: Env,
  db: Database,
  input: InboxSummaryInput,
  metering: AiMetering | null,
) {
  const accountCtx = input.accountId ? await loadAccountContext(db, input.accountId) : null;
  const recent = await loadRecentMessages(db, input.accountId ?? undefined, 20);
  if (recent.length === 0) return { summary: 'No recent messages to summarise.' };

  const digest = recent
    .map(
      (m, i) =>
        `${i + 1}. ${m.isRead ? '' : '[unread] '}${m.from?.email ?? ''}: ${m.subject ?? '(no subject)'} — ${m.preview ?? ''}`,
    )
    .join('\n');

  const ai = getAi(env);
  await assertAiCredits(metering);
  const model = pickModel('inbox-summary', accountCtx, input.modelId);
  const summary = await meteredText(
    metering,
    ai,
    model,
    'inbox-summary',
    "You summarise a user's email inbox. Be concise and actionable. Group by theme and call out anything urgent or awaiting a reply.",
    `Summarise these recent emails:\n\n${digest}`,
  );
  return { summary };
}

export interface SmartRepliesInput {
  messageId: string;
  modelId?: string | null;
}

export async function smartReplies(
  env: Env,
  db: Database,
  input: SmartRepliesInput,
  metering: AiMetering | null,
) {
  const message = await loadMessage(db, input.messageId);
  if (!message) throw new MailAiError('MESSAGE_NOT_FOUND', 'Message not found', 404);
  const accountCtx = message.accountId ? await loadAccountContext(db, message.accountId) : null;

  const ai = getAi(env);
  await assertAiCredits(metering);
  const model = pickModel('smart-replies', accountCtx, input.modelId);
  const res = await guard(() =>
    generateObject({
      model: ai.model(model),
      schema: repliesSchema,
      system: baseSystem(accountCtx, 'You suggest short, ready-to-send reply options for an email.'),
      prompt: `Suggest 3 brief, distinct reply options (e.g. an affirmative, a decline, and a follow-up) to this email:\n\n${messageContext(message)}`,
    }),
  );
  await chargeAiUsage(metering, { modelId: model, usage: res.usage, op: 'smart-replies' });
  return { replies: res.object.replies.slice(0, 3) };
}

// --- Classification (persists AI category onto `categories`) ---------------

export interface ClassifyInput {
  messageId: string;
  modelId?: string | null;
}

export interface ClassificationResult {
  messageId: string;
  accountId: string;
  subject: string | null;
  category: (typeof CLASSIFY_CATEGORIES)[number];
  priority: (typeof PRIORITIES)[number];
}

async function classifyOne(
  metering: AiMetering | null,
  ai: WeldAI,
  model: string,
  message: LoadedMessage,
): Promise<Pick<ClassificationResult, 'category' | 'priority'>> {
  const res = await guard(() =>
    generateObject({
      model: ai.model(model),
      schema: classifySchema,
      system: 'You are an email triage assistant. Classify the email into one category and a priority.',
      prompt: `Categories: ${CLASSIFY_CATEGORIES.join(', ')}.\nPriorities: ${PRIORITIES.join(', ')}.\n\nEmail:\n${messageContext(message)}`,
    }),
  );
  await chargeAiUsage(metering, { modelId: model, usage: res.usage, op: 'label', referenceId: message.id });
  return {
    category: res.object.category as ClassificationResult['category'],
    priority: res.object.priority as ClassificationResult['priority'],
  };
}

/** Persist the AI category onto `categories` (additive, deduped); flag high priority. */
async function persistClassification(
  db: Database,
  message: LoadedMessage,
  category: string,
  priority: string,
) {
  const existing = message.categories ?? [];
  const categories = Array.from(new Set([...existing, `ai:${category}`]));
  await db
    .update(mailMessages)
    .set({ categories, ...(priority === 'high' ? { isImportant: true } : {}) })
    .where(eq(mailMessages.id, message.id));
}

export async function classifyMessage(
  env: Env,
  db: Database,
  input: ClassifyInput,
  metering: AiMetering | null,
): Promise<ClassificationResult> {
  const message = await loadMessage(db, input.messageId);
  if (!message) throw new MailAiError('MESSAGE_NOT_FOUND', 'Message not found', 404);
  const accountCtx = message.accountId ? await loadAccountContext(db, message.accountId) : null;
  const ai = getAi(env);
  await assertAiCredits(metering);
  const model = pickModel('label', accountCtx, input.modelId);
  const { category, priority } = await classifyOne(metering, ai, model, message);
  await persistClassification(db, message, category, priority);
  return {
    messageId: message.id,
    accountId: message.accountId,
    subject: message.subject,
    category,
    priority,
  };
}

export interface ClassifyBatchInput {
  messageIds: string[];
  modelId?: string | null;
}

export async function classifyMessagesBatch(
  env: Env,
  db: Database,
  input: ClassifyBatchInput,
  metering: AiMetering | null,
): Promise<ClassificationResult[]> {
  const ai = getAi(env);
  await assertAiCredits(metering);
  const results: ClassificationResult[] = [];
  for (const id of input.messageIds) {
    const message = await loadMessage(db, id);
    if (!message) continue;
    const accountCtx = message.accountId ? await loadAccountContext(db, message.accountId) : null;
    const model = pickModel('label-batch', accountCtx, input.modelId);
    const { category, priority } = await classifyOne(metering, ai, model, message);
    await persistClassification(db, message, category, priority);
    results.push({
      messageId: message.id,
      accountId: message.accountId,
      subject: message.subject,
      category,
      priority,
    });
  }
  return results;
}
