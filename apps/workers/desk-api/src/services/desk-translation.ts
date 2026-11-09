/**
 * WeldDesk inbox translation (Global only).
 *
 * The customer writes in their language, the agent reads and answers in
 * theirs:
 *
 * - `translateConversation` detects the customer's language from their
 *   messages, stores it on `desk_conversations.language`, and translates the
 *   requested messages into the agent's language. Each translation is kept
 *   in KV (`WORKSPACE_CACHE`) by message id and language for 30 days, so
 *   opening the conversation again costs nothing: with the language known and
 *   every message cached there is no model call and no charge.
 *
 *   While the language is unknown, or stored as the agent's own, it is judged
 *   on the customer's newest messages only (a small call): the same language
 *   means nothing to translate, and those messages are remembered as judged,
 *   so a thread in the agent's language never pays for a full translation,
 *   and a wrong guess from a first "Hallo" is put right by the next message.
 *   The rest goes to the model in batches: one call for a long thread would
 *   cut its answer short of valid JSON.
 * - `translateReply` puts the agent's draft into the conversation's language.
 *
 * One model, `recommended.translate.free` (Llama 3.3 70B on Workers AI), via
 * `@weldsuite/ai`, metered against the workspace wallet like mail AI: the
 * credit gate before the call, the charge for the model that served after it
 * (ADR AI-005, AI-007). The Kubernetes editions have no AI provider
 * (ADR AI-011): Rust answers 503 and the platform hides the feature.
 */

import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  assertGatewayConfigured,
  billedModelId,
  createWeldAI,
  generateObject,
  jsonSchema,
  recommended,
  type WeldAI,
} from '@weldsuite/ai';
import { assertAiCredits, chargeAiUsage, type AiMetering } from '@weldsuite/core-domain/ai-billing';
import * as schema from '@weldsuite/db/schema';
import type { DeskConversation, DeskMessage } from '@weldsuite/db/lib/desk';
import type { Database } from '@weldsuite/worker-kit/db';
import type { Env } from '../types';

const TRANSLATE_MODEL = recommended.translate.free;
/** 30 days. */
export const DESK_TRANSLATION_CACHE_TTL = 30 * 24 * 60 * 60;
/** Messages translated by default: the customer's latest. */
const DEFAULT_MESSAGE_LIMIT = 50;
/** The customer's newest messages a language is judged on. */
const DETECTION_SAMPLE = 5;
/** Messages per model call. */
const TRANSLATE_BATCH = 12;
/** Characters per model call; one longer message goes alone. */
const TRANSLATE_BATCH_CHARS = 6_000;
/** Room for a batch's translations as JSON. */
const TRANSLATE_MAX_OUTPUT_TOKENS = 8_000;
/**
 * Cached for a message judged to be in the agent's language: nothing to
 * show, and no reason to judge it again. A marker no translation can be (the
 * model writes no NUL), and not empty, so it reads as a hit.
 */
const SAME_LANGUAGE = '\u0000';

export class DeskTranslationError extends Error {
  constructor(
    public readonly code: 'not_found' | 'ai_unavailable' | 'language_unknown' | 'ai_request_failed',
    message: string,
    public readonly status: 400 | 404 | 502 | 503,
  ) {
    super(message);
    this.name = 'DeskTranslationError';
  }
}

export interface DeskTranslationResult {
  language: string | null;
  targetLocale: string;
  translations: { messageId: string; text: string }[];
}

/** `desk_conversations.language` before and after a detection. */
export interface LanguageChange {
  old: string | null;
  new: string;
}

export interface DeskReplyTranslation {
  text: string;
  sourceLocale: string | null;
  targetLocale: string;
}

const translationsSchema = jsonSchema<{ language: string; translations: { id: string; text: string }[] }>({
  type: 'object',
  properties: {
    language: { type: 'string' },
    translations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, text: { type: 'string' } },
        required: ['id', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['language', 'translations'],
  additionalProperties: false,
});

const replySchema = jsonSchema<{ text: string; sourceLanguage: string }>({
  type: 'object',
  properties: { text: { type: 'string' }, sourceLanguage: { type: 'string' } },
  required: ['text', 'sourceLanguage'],
  additionalProperties: false,
});

/** `pt-BR` → `pt`: two tags name the same language when their primary subtags match. */
function primary(locale: string): string {
  return locale.trim().toLowerCase().split('-')[0] ?? '';
}

export function sameLanguage(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && primary(a) === primary(b);
}

/** What the model answered for a language, as a tag we store: `de`, `pt-br` → `pt-BR`. */
export function normalizeLocale(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value)) return null;
  const [lang, ...rest] = value.split('-');
  const tag = [lang!.toLowerCase(), ...rest.map((part) => (part.length === 2 ? part.toUpperCase() : part))].join('-');
  return tag.length <= 10 ? tag : lang!.toLowerCase();
}

/** "German (de)" for a prompt; the tag alone when the runtime can't name it. */
function languageName(locale: string): string {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(locale);
    return name && name !== locale ? `${name} (${locale})` : locale;
  } catch {
    return locale;
  }
}

function cacheKey(workspaceId: string, messageId: string, locale: string): string {
  return `desk-translation:${workspaceId}:${messageId}:${primary(locale)}`;
}

/** KV is a cache: a missing binding or a failed read or write is a miss, never an error. */
interface TranslationCache {
  get(messageId: string): Promise<string | null>;
  put(messageId: string, text: string): Promise<void>;
}

function translationCache(env: Env, workspaceId: string, locale: string): TranslationCache {
  const kv = env.WORKSPACE_CACHE as Partial<KVNamespace> | undefined;
  const usable = typeof kv?.get === 'function' && typeof kv.put === 'function';
  return {
    async get(messageId) {
      if (!usable) return null;
      try {
        return (await kv.get!(cacheKey(workspaceId, messageId, locale))) ?? null;
      } catch (err) {
        console.warn('[desk-translation] cache read failed:', err);
        return null;
      }
    },
    async put(messageId, text) {
      if (!usable) return;
      try {
        await kv.put!(cacheKey(workspaceId, messageId, locale), text, {
          expirationTtl: DESK_TRANSLATION_CACHE_TTL,
        });
      } catch (err) {
        console.warn('[desk-translation] cache write failed:', err);
      }
    },
  };
}

function getAi(env: Env): WeldAI {
  try {
    assertGatewayConfigured(env);
  } catch {
    throw new DeskTranslationError('ai_unavailable', 'AI is currently unavailable', 503);
  }
  return createWeldAI(env);
}

async function callModel<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    console.error('[desk-translation] model call failed:', err);
    throw new DeskTranslationError('ai_request_failed', 'Translation failed, try again', 502);
  }
}

async function loadConversation(db: Database, id: string): Promise<DeskConversation> {
  const [conversation] = await db
    .select()
    .from(schema.deskConversations)
    .where(eq(schema.deskConversations.id, id))
    .limit(1);
  if (!conversation) throw new DeskTranslationError('not_found', `Conversation with ID '${id}' not found`, 404);
  return conversation;
}

/** The requested messages of this conversation, or the customer's latest public messages. */
async function loadMessages(db: Database, conversationId: string, messageIds?: string[]): Promise<DeskMessage[]> {
  const m = schema.deskMessages;
  if (messageIds) {
    if (messageIds.length === 0) return [];
    const rows = await db
      .select()
      .from(m)
      .where(and(eq(m.conversationId, conversationId), inArray(m.id, messageIds)))
      .orderBy(asc(m.createdAt), asc(m.id));
    return rows.filter((row) => row.kind !== 'event' && row.body?.trim());
  }
  const rows = await db
    .select()
    .from(m)
    .where(and(eq(m.conversationId, conversationId), eq(m.authorType, 'visitor'), eq(m.kind, 'message')))
    .orderBy(asc(m.createdAt), asc(m.id));
  return rows.filter((row) => row.body?.trim()).slice(-DEFAULT_MESSAGE_LIMIT);
}

/**
 * The conversation's language, written on its own: not a ticket field, so no
 * timeline event and no attribute change. Returns whether it changed.
 */
export async function setDeskConversationLanguage(
  db: Database,
  conversationId: string,
  language: string,
): Promise<boolean> {
  const updated = await db
    .update(schema.deskConversations)
    .set({ language })
    .where(eq(schema.deskConversations.id, conversationId))
    .returning({ id: schema.deskConversations.id });
  return updated.length > 0;
}

export interface TranslateConversationOptions {
  env: Env;
  db: Database;
  workspaceId: string;
  conversationId: string;
  messageIds?: string[];
  targetLocale: string;
  metering: () => Promise<AiMetering | null>;
}

/**
 * Translate a conversation's messages into `targetLocale`. Returns the
 * stored language too, and how the conversation row changed if it did (the
 * route publishes an event for that).
 */
export async function translateConversation(
  opts: TranslateConversationOptions,
): Promise<DeskTranslationResult & { languageChange: LanguageChange | null }> {
  const { env, db, workspaceId, conversationId, targetLocale } = opts;
  const conversation = await loadConversation(db, conversationId);
  const stored = conversation.language ?? null;
  let language = stored;
  const target = normalizeLocale(targetLocale) ?? targetLocale;
  const messages = await loadMessages(db, conversationId, opts.messageIds);

  const cache = translationCache(env, workspaceId, target);
  const cached = new Map<string, string>();
  for (const message of messages) {
    const text = await cache.get(message.id);
    if (text !== null) cached.set(message.id, text);
  }

  let languageChange: LanguageChange | null = null;
  const result = () => ({
    language,
    targetLocale: target,
    // The customer writes the agent's language: nothing to show.
    translations: sameLanguage(language, target)
      ? []
      : messages.flatMap((message) => {
          const text = cached.get(message.id);
          return text === undefined || text === SAME_LANGUAGE ? [] : [{ messageId: message.id, text }];
        }),
    languageChange,
  });

  /** A language to translate from: known, and not the agent's own. */
  const foreign = () => !!language && !sameLanguage(language, target);

  let queue = messages.filter((message) => !cached.has(message.id));
  if (queue.length === 0) {
    if (language || messages.length === 0) return result();
    // Every message is cached but the language was never stored: judge it.
    queue = detectionSample(messages);
  }

  const ai = getAi(env);
  const metering = await opts.metering();
  await assertAiCredits(metering);

  /** One model call for a batch, charged for the model that served it. */
  const translate = async (batch: DeskMessage[]) => {
    const res = await generateObject({
      model: ai.model(TRANSLATE_MODEL),
      schema: translationsSchema,
      maxOutputTokens: TRANSLATE_MAX_OUTPUT_TOKENS,
      system: [
        'You translate customer support conversations.',
        "First name the language the customer writes in, as an ISO 639-1 code (for example 'de'): judge it from the messages whose role is customer.",
        `Then translate every message into ${languageName(target)}.`,
        'Keep the meaning, tone, names, numbers, links and line breaks. Translate only; add nothing and leave nothing out.',
        'Return each translation with the id of its message.',
      ].join('\n'),
      prompt: JSON.stringify(
        batch.map((message) => ({
          id: message.id,
          role: message.authorType === 'visitor' ? 'customer' : 'support',
          text: message.body ?? '',
        })),
      ),
    });
    await chargeAiUsage(metering, {
      modelId: billedModelId(TRANSLATE_MODEL, res),
      usage: res.usage,
      op: 'desk_translate',
    });
    return res.object;
  };

  /** Store what a call named as the customer's language, when it is news. */
  const adopt = async (raw: string | null | undefined) => {
    const detected = normalizeLocale(raw);
    if (!detected || detected === language) return;
    if (await setDeskConversationLanguage(db, conversationId, detected)) {
      languageChange = { old: stored, new: detected };
    }
    language = detected;
  };

  const keep = async (batch: DeskMessage[], items: { id: string; text: string }[] | undefined) => {
    const wanted = new Set(batch.map((message) => message.id));
    for (const item of items ?? []) {
      if (!wanted.has(item.id) || typeof item.text !== 'string') continue;
      // An empty answer is nothing to show; remembered, so it is not asked for again.
      const text = item.text || SAME_LANGUAGE;
      cached.set(item.id, text);
      await cache.put(item.id, text);
    }
  };

  let probed = false;
  if (!foreign()) {
    // Unknown, or the agent's own language as far as we know: judge it on the
    // customer's newest messages before paying for anything more.
    const probe = detectionSample(queue);
    const answer = await callModel(() => translate(probe));
    await adopt(answer.language);
    if (sameLanguage(language, target)) {
      for (const message of queue) {
        cached.set(message.id, SAME_LANGUAGE);
        await cache.put(message.id, SAME_LANGUAGE);
      }
      return result();
    }
    await keep(probe, answer.translations);
    probed = true;
    // Everything else not translated yet, the messages judged "same language"
    // before the conversation turned out foreign included.
    const judged = new Set(probe.map((message) => message.id));
    queue = messages.filter(
      (message) => !judged.has(message.id) && (cached.get(message.id) ?? SAME_LANGUAGE) === SAME_LANGUAGE,
    );
  }

  // The rest, a batch per call. Without a probe, the batch with the newest
  // messages also says whether the customer changed language.
  const batches = batchesOf(queue);
  const settled = await Promise.allSettled(
    batches.map(async (batch, index) => {
      const answer = await translate(batch);
      if (!probed && index === batches.length - 1) await adopt(answer.language);
      await keep(batch, answer.translations);
    }),
  );
  const failures = settled.filter((outcome) => outcome.status === 'rejected');
  if (failures.length > 0) {
    console.error('[desk-translation] model call failed:', failures[0]!.reason);
    // Nothing came back at all: say so. Otherwise show what did; the rest is
    // translated on the next request.
    if (!probed && failures.length === settled.length) {
      throw new DeskTranslationError('ai_request_failed', 'Translation failed, try again', 502);
    }
  }
  return result();
}

/**
 * The messages a language is judged on: the customer's newest (any author's
 * when none are the customer's), a handful and within one call's size.
 */
function detectionSample(messages: DeskMessage[]): DeskMessage[] {
  const fromCustomer = messages.filter((message) => message.authorType === 'visitor');
  const pool = fromCustomer.length > 0 ? fromCustomer : messages;
  const sample: DeskMessage[] = [];
  let chars = 0;
  for (let i = pool.length - 1; i >= 0 && sample.length < DETECTION_SAMPLE; i--) {
    const size = pool[i]!.body?.length ?? 0;
    if (sample.length > 0 && chars + size > TRANSLATE_BATCH_CHARS) break;
    sample.unshift(pool[i]!);
    chars += size;
  }
  return sample;
}

/** Messages split into calls: at most `TRANSLATE_BATCH` each, and `TRANSLATE_BATCH_CHARS` unless one message is longer. */
function batchesOf(messages: DeskMessage[]): DeskMessage[][] {
  const batches: DeskMessage[][] = [];
  let batch: DeskMessage[] = [];
  let chars = 0;
  for (const message of messages) {
    const size = message.body?.length ?? 0;
    if (batch.length > 0 && (batch.length === TRANSLATE_BATCH || chars + size > TRANSLATE_BATCH_CHARS)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(message);
    chars += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export interface TranslateReplyOptions {
  env: Env;
  db: Database;
  conversationId: string;
  text: string;
  targetLocale?: string;
  metering: () => Promise<AiMetering | null>;
}

/** The agent's draft in the conversation's language (or `targetLocale`). */
export async function translateReply(opts: TranslateReplyOptions): Promise<DeskReplyTranslation> {
  const conversation = await loadConversation(opts.db, opts.conversationId);
  const target = normalizeLocale(opts.targetLocale ?? conversation.language);
  if (!target) {
    throw new DeskTranslationError(
      'language_unknown',
      "The customer's language isn't known yet: translate the conversation first",
      400,
    );
  }

  const ai = getAi(opts.env);
  const metering = await opts.metering();
  await assertAiCredits(metering);
  const res = await callModel(() =>
    generateObject({
      model: ai.model(TRANSLATE_MODEL),
      schema: replySchema,
      maxOutputTokens: TRANSLATE_MAX_OUTPUT_TOKENS,
      system: [
        `You translate a support agent's reply to a customer into ${languageName(target)}.`,
        'Keep the meaning, tone, names, numbers, links, placeholders and line breaks. Translate only; add nothing.',
        "Also name the language the agent wrote in, as an ISO 639-1 code (for example 'en').",
      ].join('\n'),
      prompt: opts.text,
    }),
  );
  await chargeAiUsage(metering, {
    modelId: billedModelId(TRANSLATE_MODEL, res),
    usage: res.usage,
    op: 'desk_translate',
  });
  return {
    text: res.object.text,
    sourceLocale: normalizeLocale(res.object.sourceLanguage),
    targetLocale: target,
  };
}
