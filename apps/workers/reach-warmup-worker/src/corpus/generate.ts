/**
 * Monthly corpus refresh: ask a model for fresh English business email threads,
 * keep only those that pass the same checks as the stored set, and write them
 * to R2 (`latest.json` for the planner, `<yyyy-mm>.json` as an archive,
 * `meta.json` for the age check). WeldSuite pays for the calls; there is no
 * credit metering. Any failure leaves the previous set (or the built-in one)
 * in place.
 */

import { createWeldAI, generateObject, isGatewayConfigured, jsonSchema, recommended, type WeldAI } from '@weldsuite/ai';
import { z } from 'zod';
import type { Env } from '../env';
import {
  CORPUS_LATEST_KEY,
  CORPUS_MAX_AGE_MS,
  CORPUS_META_KEY,
  CORPUS_PREVIOUS_KEY,
  CORPUS_PREFIX,
  MIN_GENERATED_THREADS,
} from './constants';
import { resetCorpusCache } from './load';
import type { CorpusThread } from './types';
import { FORBIDDEN_WORDS, parseCorpusThread } from './validate';

/**
 * Sonnet class: this text is read by mailbox providers and by people, so it has
 * to sound like business email, and the whole run is a dozen calls a month.
 */
export const CORPUS_MODEL_ID = recommended.draft.quality;

export const THREADS_PER_BATCH = 10;
export const BATCH_COUNT = 12;
/** Calls in flight at once: keeps the run well inside a cron invocation. */
const BATCH_CONCURRENCY = 4;
const BATCH_TIMEOUT_MS = 240_000;
const MAX_OUTPUT_TOKENS = 12_000;

export const TOPICS: readonly string[] = [
  'scheduling a call or a meeting',
  'following up on a quote or a proposal',
  'a question about an invoice or a payment',
  'a project status check',
  'an introduction between two business contacts',
  'scheduling an interview for a job opening',
  'onboarding a new supplier or client',
  'event logistics such as catering, venue and headcount',
  'feedback on a draft document',
  'office and facilities admin such as badges, rooms and printers',
  'small talk after meeting at a conference, with a work hook',
  'thanking someone after a meeting',
  'rescheduling an appointment',
  'a request for a professional reference',
  'timing of a contract review',
  'a budget or approval question',
  'a delayed or missing delivery',
  'planning a training session',
  'an agenda for a review meeting',
  'connecting someone with a colleague',
  'meeting notes and action items',
  'a handover before going on leave',
  'a discrepancy in a monthly report',
  'review of text for a company website',
  'a request for design files or a logo',
  'planning a customer or site visit',
  'an invitation to speak or join a panel',
  'asking for a recommendation for a local professional',
  'a planning workshop for the team',
  'preparing the first week of a new employee',
  'ordering equipment for a team',
  'discussing the results of a customer survey',
  'a catch-up coffee or lunch between contacts',
  'delivery windows and access instructions for a site',
  'slides or material for a presentation',
  'a question about an internal expense policy',
  'translation or localisation of a document',
  'a visit to a warehouse or a factory',
  'an office move',
  'feedback after a job interview',
  'a request for a deadline extension',
  'a request for an export of data for an audit',
  'a calendar conflict',
  'planning a team lunch or social event',
  'access permissions to a shared folder',
  'clarifying a specification or a drawing',
  'the kickoff of a small pilot project',
  'renewing a service agreement',
  'feedback on product samples or a prototype',
  'a question about a confidentiality agreement',
  'asking an experienced colleague for advice',
  'a heads-up about a customer complaint',
  'travel arrangements for a team offsite',
  'reconciling accounts at the end of a quarter',
  'staffing and shift planning',
  'an apology for a late reply',
  'changing the time of a recurring meeting',
  'a mention in a local publication',
  'catching up after a holiday',
  'scheduling a yearly stock count',
  'a request for a quote for services',
  'preparing a joint presentation',
  'holiday cover planning for a small team',
  'a shipping or customs question',
];

const TONES: readonly string[] = [
  'warm and friendly',
  'brisk and businesslike',
  'formal and polite',
  'relaxed and casual',
  'concise, almost terse',
  'thoughtful and detailed',
];

const FORMATS: readonly string[] = [
  'a greeting with the first name and a sign-off with the first name',
  'no greeting, straight to the point, sign-off with the first name',
  'a greeting with the first name, no sign-off',
  'a greeting with the first name and a formal sign-off with first and last name',
  'no greeting and no sign-off, like a quick reply',
];

const LENGTHS: readonly string[] = [
  'one or two sentences per message',
  'three or four sentences per message',
  'four to six sentences per message, in short paragraphs',
  'mixed: some messages one sentence, others longer',
];

const MESSAGE_COUNTS: readonly number[] = [2, 3, 4, 3, 2, 3, 4, 2, 3, 3];

export interface ThreadBrief {
  topic: string;
  messageCount: number;
  tone: string;
  format: string;
  length: string;
}

/** The briefs of one batch. Pure, so that the 12 batches differ and a run is reproducible. */
export function buildBatchPlan(batchIndex: number, count: number = THREADS_PER_BATCH): ThreadBrief[] {
  const briefs: ThreadBrief[] = [];
  for (let i = 0; i < count; i += 1) {
    const slot = batchIndex * count + i;
    briefs.push({
      topic: TOPICS[(slot * 7) % TOPICS.length] ?? TOPICS[0] ?? '',
      messageCount: MESSAGE_COUNTS[slot % MESSAGE_COUNTS.length] ?? 3,
      tone: TONES[(slot * 5 + batchIndex) % TONES.length] ?? TONES[0] ?? '',
      format: FORMATS[(slot * 3) % FORMATS.length] ?? FORMATS[0] ?? '',
      length: LENGTHS[(slot * 2 + 1) % LENGTHS.length] ?? LENGTHS[0] ?? '',
    });
  }
  return briefs;
}

const SYSTEM_PROMPT = [
  'You write realistic English business emails exchanged between two people at different small or mid-sized companies. They know each other a little from work. The emails are ordinary day-to-day correspondence.',
  'Each thread has a "starter" who writes the first message and a "responder" who replies, alternating: starter, responder, starter, responder. Every reply answers what the previous message said and moves the conversation on.',
  'Names: never write a real or invented name. Use these placeholders only: {{recipientFirstName}} is the person the message is addressed to, {{senderFirstName}} and {{senderLastName}} are the person writing that message, {{recipientLastName}} is the addressee\'s last name. A greeting uses {{recipientFirstName}}; a sign-off uses {{senderFirstName}} (optionally followed by {{senderLastName}}). The placeholders always refer to the writer and the addressee of that very message, so in a reply they swap places.',
  'Plain text only: no markdown, no bullet symbols, no bold, no emoji, no HTML. Separate paragraphs with a blank line.',
  'Never include a link, a web address, an email address, a phone number, a currency symbol, or a mention of an attachment or an enclosed file. Numbers, times and weekdays are fine. No real company, brand or person names.',
  'No marketing language and no sales pitches: nothing about offers, prices as promotions, deals or discounts, and no urgency or pressure. Nothing about email, mailboxes, deliverability, testing or warming up.',
  `Never use these words: ${FORBIDDEN_WORDS.filter((word) => !word.includes('-')).join(', ')}.`,
  'Vary the voice of each thread: sentence length, warmth, formality, greetings and sign-offs, and how much detail is given. Do not start threads the same way. Avoid stock phrases such as "I hope this email finds you well".',
  'The subject is a short plain phrase of 2 to 7 words without "Re:" or "Fwd:". Output JSON only, with one thread per brief, in the order of the briefs.',
].join('\n');

function buildBatchPrompt(briefs: readonly ThreadBrief[]): string {
  const lines = briefs.map(
    (brief, index) =>
      `Brief ${index + 1}: topic "${brief.topic}"; exactly ${brief.messageCount} messages; tone: ${brief.tone}; format: ${brief.format}; length: ${brief.length}.`,
  );
  return `Write ${briefs.length} separate email threads, one for each brief.\n\n${lines.join('\n')}`;
}

interface BatchOutput {
  threads: Array<{ subject: string; messages: Array<{ author: string; body: string }> }>;
}

// A plain JSON schema, not zod: zod v3 schemas trip TS2589 against the AI SDK v7 generics (same as reach-api's classifier).
const batchSchema = jsonSchema<BatchOutput>({
  type: 'object',
  properties: {
    threads: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          messages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                author: { type: 'string', enum: ['starter', 'responder'] },
                body: { type: 'string' },
              },
              required: ['author', 'body'],
              additionalProperties: false,
            },
          },
        },
        required: ['subject', 'messages'],
        additionalProperties: false,
      },
    },
  },
  required: ['threads'],
  additionalProperties: false,
});

/** Typographic characters models like, folded to the plain ones a person types. */
export function sanitizeGeneratedText(text: string): string {
  return text
    .replaceAll('\r\n', '\n')
    .replaceAll(/[‘’]/g, "'")
    .replaceAll(/[“”]/g, '"')
    .replaceAll('…', '...')
    .replaceAll('—', ' - ')
    .replaceAll('–', ' - ')
    .replaceAll(' ', ' ')
    .split('\n')
    .map((line) => line.replaceAll(/ {2,}/g, ' ').trimEnd())
    .join('\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanSubject(subject: string): string {
  let rest = sanitizeGeneratedText(subject).replaceAll('\n', ' ');
  while (/^(?:re|fwd?):/i.test(rest)) rest = rest.slice(rest.indexOf(':') + 1).trim();
  return rest.endsWith('.') ? rest.slice(0, -1) : rest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Shape a model draft into a thread candidate; anything off-shape becomes null and fails validation. */
function toCandidate(draft: unknown, id: string): unknown {
  if (!isRecord(draft) || typeof draft.subject !== 'string' || !Array.isArray(draft.messages)) return null;
  return {
    id,
    subject: cleanSubject(draft.subject),
    messages: (draft.messages as unknown[]).map((message) =>
      isRecord(message) && typeof message.body === 'string'
        ? { author: message.author, body: sanitizeGeneratedText(message.body) }
        : null,
    ),
  };
}

async function generateBatch(ai: WeldAI, batchIndex: number): Promise<unknown[]> {
  const result = await generateObject({
    model: ai.model(CORPUS_MODEL_ID),
    schema: batchSchema,
    system: SYSTEM_PROMPT,
    prompt: buildBatchPrompt(buildBatchPlan(batchIndex)),
    maxRetries: 1,
    temperature: 0.9,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    abortSignal: AbortSignal.timeout(BATCH_TIMEOUT_MS),
  });
  const output: unknown = result.object;
  return isRecord(output) && Array.isArray(output.threads) ? (output.threads as unknown[]) : [];
}

function threadId(now: Date, sequence: number): string {
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `gen-${now.getUTCFullYear()}-${month}-${String(sequence).padStart(3, '0')}`;
}

/** Collects accepted threads: valid, with a subject no earlier thread has. */
class ThreadCollector {
  readonly threads: CorpusThread[] = [];
  rejected = 0;
  private readonly subjects = new Set<string>();

  constructor(private readonly now: Date) {}

  add(draft: unknown): void {
    const thread = parseCorpusThread(toCandidate(draft, threadId(this.now, this.threads.length + 1)));
    const key = thread?.subject.toLowerCase();
    if (!thread || key === undefined || this.subjects.has(key)) {
      this.rejected += 1;
      return;
    }
    this.subjects.add(key);
    this.threads.push(thread);
  }
}

function describeFailure(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Run every batch (a few at a time) and keep the drafts that pass validation, one per subject. */
async function collectThreads(ai: WeldAI, now: Date): Promise<CorpusThread[]> {
  const collector = new ThreadCollector(now);
  const batches = Array.from({ length: BATCH_COUNT }, (_, index) => index);

  for (let start = 0; start < batches.length; start += BATCH_CONCURRENCY) {
    const round = batches.slice(start, start + BATCH_CONCURRENCY);
    const results = await Promise.allSettled(round.map((batchIndex) => generateBatch(ai, batchIndex)));
    for (const result of results) {
      if (result.status === 'rejected') {
        console.warn('[reach-warmup] corpus batch failed:', describeFailure(result.reason));
        continue;
      }
      result.value.forEach((draft) => collector.add(draft));
    }
  }
  if (collector.rejected > 0) {
    console.warn(`[reach-warmup] corpus refresh dropped ${collector.rejected} threads that failed validation`);
  }
  return collector.threads;
}

const metaSchema = z.object({ generatedAt: z.string() });

/** When `latest.json` was generated, or null when there is no readable meta. */
async function readGeneratedAt(storage: R2Bucket): Promise<number | null> {
  const object = await storage.get(CORPUS_META_KEY);
  if (!object) return null;
  try {
    const meta = metaSchema.safeParse(JSON.parse(await object.text()));
    const time = meta.success ? Date.parse(meta.data.generatedAt) : Number.NaN;
    return Number.isNaN(time) ? null : time;
  } catch {
    return null;
  }
}

async function storeCorpus(storage: R2Bucket, threads: CorpusThread[], now: Date): Promise<void> {
  const json = JSON.stringify(threads);
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const options = { httpMetadata: { contentType: 'application/json' } };
  await storage.put(`${CORPUS_PREFIX}${now.getUTCFullYear()}-${month}.json`, json, options);
  // Keep the set being replaced: threads planned or mid-conversation still reference its ids.
  const replaced = await storage.get(CORPUS_LATEST_KEY);
  if (replaced) await storage.put(CORPUS_PREVIOUS_KEY, await replaced.text(), options);
  await storage.put(CORPUS_LATEST_KEY, json, options);
  // Last, so a meta file only ever describes a latest.json that exists.
  const meta = { generatedAt: now.toISOString(), threads: threads.length, model: CORPUS_MODEL_ID };
  await storage.put(CORPUS_META_KEY, JSON.stringify(meta), options);
}

/**
 * Generate a new corpus when the stored one is older than 30 days (or there is
 * none). A no-op without R2 or an AI gateway. Keeps the old set when fewer than
 * {@link MIN_GENERATED_THREADS} threads survive validation. Never throws.
 */
export async function refreshCorpus(env: Env, now: Date): Promise<{ refreshed: boolean }> {
  const storage = env.STORAGE;
  if (!storage || !isGatewayConfigured(env)) return { refreshed: false };

  try {
    const generatedAt = await readGeneratedAt(storage);
    if (generatedAt !== null && now.getTime() - generatedAt < CORPUS_MAX_AGE_MS) return { refreshed: false };

    const threads = await collectThreads(createWeldAI(env), now);
    if (threads.length < MIN_GENERATED_THREADS) {
      console.warn(
        `[reach-warmup] corpus refresh produced ${threads.length} valid threads (need ${MIN_GENERATED_THREADS}), keeping the current set`,
      );
      return { refreshed: false };
    }

    await storeCorpus(storage, threads, now);
    resetCorpusCache();
    return { refreshed: true };
  } catch (err) {
    console.warn('[reach-warmup] corpus refresh failed:', err instanceof Error ? err.message : err);
    return { refreshed: false };
  }
}
