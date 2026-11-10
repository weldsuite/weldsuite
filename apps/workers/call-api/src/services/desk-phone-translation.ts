/**
 * Live spoken translation on a WeldDesk phone call (Global only, feature
 * `desk-ai`).
 *
 * An agent who answered an inbound call in the browser switches Translate on:
 *
 * - Telnyx transcribes both legs (`transcription_start`, track `inbound` on
 *   each: the party on that leg). The `client_state` of each start names the
 *   call and who speaks (`translate: 'caller' | 'agent'`), so a
 *   `call.transcription` webhook needs no guessing.
 * - Every final line is translated with `@weldsuite/ai` (the model family inbox
 *   translation uses) and published to the answering agent's browser as
 *   `phone.caption`. The agent's own translated words are optionally spoken on
 *   the caller's leg only (`speak` with `target_legs: 'self'`).
 * - With recording on for the dialled number, each line is kept on the call's
 *   desk conversation as an internal note.
 * - Cost: a credit gate before starting, each model call charged for the model
 *   that served it, and the transcription minutes charged once when the
 *   translation stops or the call ends.
 *
 * State is `voip_calls.translation`. Telnyx commands that fail because a leg is
 * gone are logged and swallowed, except at start, where they fail the request.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  assertGatewayConfigured,
  billedModelId,
  createWeldAI,
  generateObject,
  jsonSchema,
  recommended,
} from '@weldsuite/ai';
import {
  assertAiCredits,
  chargeAiUsage,
  InsufficientAiCreditsError,
  resolveAiMetering,
  type AiMetering,
} from '@weldsuite/core-domain/ai-billing';
import {
  callTranslationLanguage,
  callTranslationTtsLocale,
  primaryLanguage,
  type CallTranslationState,
  type PhoneCaptionEvent,
  type PhoneTranslationEvent,
  type StartCallTranslation,
  type UpdateCallTranslation,
} from '@weldsuite/core-api-client/schemas/desk-call-translation';
import { consumeCredits, grantCredits, resolveInternalWorkspaceId, SERVICE_CREDIT_RATES } from '@weldsuite/credits';
import { appendDeskMessage } from '@weldsuite/db/lib/desk';
import type { VoipCallTranslation } from '@weldsuite/db/schema/voip-calls';
import { getMasterDb, schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { encodeClientState, telnyxSpeak } from '../lib/telnyx';
import { telnyxTranscriptionStart, telnyxTranscriptionStop } from '../lib/telnyx-transcription';
import { fanoutDeskPhoneMessage } from '../lib/desk-phone-fanout';
import { PHONE_VOICE } from '../lib/desk-phone-options';
import { sendPhoneInboxEvent } from '../lib/desk-phone-realtime';
import { bestEffort } from './desk-phone-queue';
import { loadCall, type PhoneCtx, type VoipCallRow } from './desk-phone-ring';

const TRANSLATE_MODEL = recommended.translate.free;
/** Room for one spoken sentence or two as JSON. */
const TRANSLATE_MAX_OUTPUT_TOKENS = 1_000;
/** Shortest transcript worth translating (a lone sound is not a line). */
const MIN_LINE_CHARS = 2;
/** Transcript confidence under which an utterance does not count towards detecting the language. */
const MIN_DETECTION_CONFIDENCE = 0.5;
/** Agreeing utterances before the caller's language is locked in. */
const DETECTION_UTTERANCES = 2;
const DETECTION_TTL_SECONDS = 6 * 60 * 60;

export type CallTranslationRefusalCode =
  | 'not_found'
  | 'not_live'
  | 'not_your_call'
  | 'already_translating'
  | 'not_translating'
  | 'ai_unavailable'
  | 'telnyx_failed';

export class CallTranslationError extends Error {
  constructor(
    readonly code: CallTranslationRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'CallTranslationError';
  }
}

export type TranslationSide = 'caller' | 'agent';

// ── State ───────────────────────────────────────────────────────────────────

export function activeTranslation(call: Pick<VoipCallRow, 'translation'>): VoipCallTranslation | null {
  const t = call.translation;
  return t && typeof t === 'object' && !t.stoppedAt ? t : null;
}

/** Whether the agent's words can be spoken to the caller: a voice exists for their language. */
export function speakAvailable(t: Pick<VoipCallTranslation, 'callerLanguage'>): boolean {
  return callTranslationTtsLocale(t.callerLanguage) !== null;
}

export function toTranslationState(callId: string, t: VoipCallTranslation): CallTranslationState {
  return {
    callId,
    active: !t.stoppedAt,
    callerLanguage: t.callerLanguage,
    agentLanguage: t.agentLanguage,
    speakToCaller: t.speakToCaller,
    speakAvailable: speakAvailable(t),
    startedAt: t.startedAt,
    startedById: t.startedById,
    stoppedAt: t.stoppedAt,
  };
}

const IS_ACTIVE = sql`${schema.voipCalls.translation} is not null and jsonb_typeof(${schema.voipCalls.translation}) = 'object' and ${schema.voipCalls.translation}->>'stoppedAt' is null`;
const IS_IDLE = sql`(${schema.voipCalls.translation} is null or jsonb_typeof(${schema.voipCalls.translation}) = 'null' or ${schema.voipCalls.translation}->>'stoppedAt' is not null)`;

// ── Guards ──────────────────────────────────────────────────────────────────

/** The call is inbound, answered by this member and still up, with both legs known. */
function assertOwnLiveCall(call: VoipCallRow, userId: string): void {
  if (call.direction !== 'inbound' || !call.providerCallId || !call.agentAnsweredAt || call.endedAt) {
    throw new CallTranslationError('not_live', 'The call is not live');
  }
  if (call.answeredByUserId !== userId) {
    throw new CallTranslationError('not_your_call', 'Only the member who answered can translate this call');
  }
}

async function answeredLegOf(db: PhoneCtx['db'], call: VoipCallRow, userId: string): Promise<string> {
  const l = schema.deskPhoneCallLegs;
  const [leg] = await db
    .select({ providerCallId: l.providerCallId })
    .from(l)
    .where(and(eq(l.callId, call.id), eq(l.userId, userId), eq(l.status, 'answered')))
    .limit(1);
  if (!leg?.providerCallId) throw new CallTranslationError('not_live', 'The call is not live');
  return leg.providerCallId;
}

function aiOf(env: PhoneCtx['env']): ReturnType<typeof createWeldAI> {
  try {
    assertGatewayConfigured(env);
  } catch {
    throw new CallTranslationError('ai_unavailable', 'AI is currently unavailable');
  }
  return createWeldAI(env);
}

// ── Telnyx ──────────────────────────────────────────────────────────────────

const stateOf = (ctx: PhoneCtx, callId: string, side: TranslationSide) =>
  encodeClientState({ workspaceId: ctx.workspaceId, callId, translate: side });

function legOf(call: VoipCallRow, t: VoipCallTranslation, side: TranslationSide): string | null {
  return side === 'caller' ? call.providerCallId : t.agentLegId;
}

/** The transcription language of a side: the party's own, or null to detect the caller's. */
function sideLanguage(t: VoipCallTranslation, side: TranslationSide): string | null {
  return side === 'caller' ? t.callerLanguage : t.agentLanguage;
}

async function startSide(ctx: PhoneCtx, call: VoipCallRow, t: VoipCallTranslation, side: TranslationSide): Promise<void> {
  const control = legOf(call, t, side);
  if (!control) throw new CallTranslationError('not_live', 'The call is not live');
  try {
    await telnyxTranscriptionStart(ctx.env, control, {
      language: sideLanguage(t, side),
      track: 'inbound',
      clientState: stateOf(ctx, call.id, side),
    });
  } catch (err) {
    console.error(`[desk-phone-translation] transcription_start (${side}) failed:`, err);
    throw new CallTranslationError('telnyx_failed', 'Could not start the live transcription');
  }
}

async function stopSide(ctx: PhoneCtx, call: VoipCallRow, t: VoipCallTranslation, side: TranslationSide): Promise<void> {
  const control = legOf(call, t, side);
  if (!control) return;
  await bestEffort(`transcription_stop (${side})`, () =>
    telnyxTranscriptionStop(ctx.env, control, { clientState: stateOf(ctx, call.id, side) }),
  );
}

// ── Start / update / stop ───────────────────────────────────────────────────

export async function startTranslation(
  ctx: PhoneCtx,
  call: VoipCallRow,
  userId: string,
  input: StartCallTranslation,
): Promise<VoipCallTranslation> {
  assertOwnLiveCall(call, userId);
  if (activeTranslation(call)) throw new CallTranslationError('already_translating', 'The call is already translated');
  const agentLegId = await answeredLegOf(ctx.db, call, userId);

  // The AI gate and the credit gate come before anything is started.
  aiOf(ctx.env);
  await assertAiCredits(await resolveAiMetering(ctx.env, ctx.workspaceId, userId));

  const next: VoipCallTranslation = {
    callerLanguage: input.callerLanguage === 'auto' ? null : input.callerLanguage,
    agentLanguage: input.agentLanguage,
    speakToCaller: input.speakToCaller ?? true,
    agentLegId,
    startedAt: new Date().toISOString(),
    startedById: userId,
    stoppedAt: null,
  };
  const c = schema.voipCalls;
  const [claimed] = await ctx.db
    .update(c)
    .set({ translation: next, updatedAt: new Date() })
    .where(and(eq(c.id, call.id), isNull(c.endedAt), IS_IDLE))
    .returning({ id: c.id });
  if (!claimed) throw new CallTranslationError('already_translating', 'The call is already translated');

  const started: TranslationSide[] = [];
  try {
    for (const side of ['caller', 'agent'] as const) {
      await startSide(ctx, call, next, side);
      started.push(side);
    }
  } catch (err) {
    for (const side of started) await stopSide(ctx, call, next, side);
    await ctx.db
      .update(c)
      .set({ translation: call.translation ?? null, updatedAt: new Date() })
      .where(eq(c.id, call.id));
    throw err;
  }
  return next;
}

export async function updateTranslation(
  ctx: PhoneCtx,
  call: VoipCallRow,
  userId: string,
  patch: UpdateCallTranslation,
): Promise<VoipCallTranslation> {
  assertOwnLiveCall(call, userId);
  const current = activeTranslation(call);
  if (!current) throw new CallTranslationError('not_translating', 'The call is not being translated');

  const callerLanguage =
    patch.callerLanguage === undefined ? current.callerLanguage : patch.callerLanguage === 'auto' ? null : patch.callerLanguage;
  const next: VoipCallTranslation = {
    ...current,
    callerLanguage,
    agentLanguage: patch.agentLanguage ?? current.agentLanguage,
    speakToCaller: patch.speakToCaller ?? current.speakToCaller,
  };
  const c = schema.voipCalls;
  const [updated] = await ctx.db
    .update(c)
    .set({ translation: next, updatedAt: new Date() })
    .where(and(eq(c.id, call.id), isNull(c.endedAt), IS_ACTIVE))
    .returning({ id: c.id });
  if (!updated) throw new CallTranslationError('not_translating', 'The call is not being translated');

  // A side's transcription runs in its party's language: restart it when that changes.
  if (next.callerLanguage !== current.callerLanguage) await restartSide(ctx, call, next, 'caller');
  if (next.agentLanguage !== current.agentLanguage) await restartSide(ctx, call, next, 'agent');
  return next;
}

async function restartSide(ctx: PhoneCtx, call: VoipCallRow, t: VoipCallTranslation, side: TranslationSide): Promise<void> {
  await stopSide(ctx, call, t, side);
  await startSide(ctx, call, t, side);
}

/** The minutes of a translation, started minutes rounded up (at least one). */
export function translationMinutes(startedAt: string, stoppedAt: Date): number {
  const ms = stoppedAt.getTime() - new Date(startedAt).getTime();
  return Math.max(1, Math.ceil(ms / 60_000));
}

/** Charge the transcription minutes once; the idempotency key is the session's. */
async function settleTranslationCredits(ctx: PhoneCtx, callId: string, t: VoipCallTranslation, stoppedAt: Date): Promise<void> {
  try {
    const masterDb = getMasterDb(ctx.env);
    const internalWsId = await resolveInternalWorkspaceId(masterDb, ctx.workspaceId);
    if (!internalWsId) return;
    const minutes = translationMinutes(t.startedAt, stoppedAt);
    const cost = minutes * SERVICE_CREDIT_RATES.callTranscriptionPerMinute;
    const key = `voip-translate:${callId}:${t.startedAt}`;
    const base = {
      workspaceId: internalWsId,
      amount: cost,
      serviceType: 'call_transcription' as const,
      idempotencyKey: key,
      referenceId: callId,
      referenceType: 'voip_call',
      metadata: { callId, minutes, startedAt: t.startedAt, stoppedAt: stoppedAt.toISOString() },
    };
    const settle = await consumeCredits(masterDb, {
      ...base,
      description: `Call translation (${minutes} min)`,
    });
    if (!settle.ok) {
      // The minutes were spent: record them as debt rather than leave them unbilled.
      await grantCredits(masterDb, {
        ...base,
        amount: -cost,
        type: 'adjustment',
        description: `Call translation (${minutes} min) — settled into negative balance`,
        metadata: { ...base.metadata, forcedSettlement: true },
      });
    }
  } catch (err) {
    console.error('[desk-phone-translation] credit settlement FAILED (untracked transcription!):', err);
  }
}

export interface StopOptions {
  /** Why the system (not the agent) stopped it. */
  reason?: 'no_credits' | 'call_ended';
  /** Both legs are gone: no `transcription_stop` to send. */
  legsGone?: boolean;
  at?: Date;
}

/**
 * Stop a call's translation: mark it stopped (once), stop both transcriptions,
 * charge the minutes, tell the browser. Returns the stopped state, or null when
 * it was not running.
 */
export async function stopTranslation(
  ctx: PhoneCtx,
  call: VoipCallRow,
  opts: StopOptions = {},
): Promise<VoipCallTranslation | null> {
  const current = activeTranslation(call);
  if (!current) return null;
  const stoppedAt = opts.at ?? new Date();
  const stopped: VoipCallTranslation = { ...current, stoppedAt: stoppedAt.toISOString() };
  const c = schema.voipCalls;
  const [won] = await ctx.db
    .update(c)
    .set({ translation: stopped, updatedAt: new Date() })
    .where(and(eq(c.id, call.id), IS_ACTIVE))
    .returning({ id: c.id });
  if (!won) return null;

  if (!opts.legsGone) {
    for (const side of ['caller', 'agent'] as const) await stopSide(ctx, call, current, side);
  }
  await settleTranslationCredits(ctx, call.id, current, stoppedAt);
  const event: PhoneTranslationEvent = {
    callId: call.id,
    active: false,
    callerLanguage: stopped.callerLanguage,
    speakAvailable: speakAvailable(stopped),
    stoppedReason: opts.reason ?? null,
  };
  await sendPhoneInboxEvent(ctx.env, ctx.workspaceId, call.answeredByUserId ?? current.startedById, 'phone.translation', event);
  return stopped;
}

/** The caller's `call.hangup`: stop and charge the translation when it was running. Never throws. */
export async function finishCallTranslation(ctx: PhoneCtx, callId: string): Promise<void> {
  try {
    const call = await loadCall(ctx.db, callId);
    if (!call) return;
    await stopTranslation(ctx, call, { reason: 'call_ended', legsGone: true, at: call.endedAt ?? new Date() });
  } catch (err) {
    console.error('[desk-phone-translation] stopping the translation at hangup failed:', err);
  }
}

// ── Transcript lines ────────────────────────────────────────────────────────

export interface CallTranscriptionEvent {
  ctx: PhoneCtx;
  callId: string;
  /** The webhook event's id: the caption's line id. */
  lineId: string;
  /** ISO time of the line (the webhook's `occurred_at`). */
  at: string;
  clientState: Record<string, string>;
  payload: Record<string, unknown>;
}

interface TranscriptionData {
  transcript?: unknown;
  is_final?: unknown;
  confidence?: unknown;
}

const lineSchema = jsonSchema<{ language: string; translation: string }>({
  type: 'object',
  properties: { language: { type: 'string' }, translation: { type: 'string' } },
  required: ['language', 'translation'],
  additionalProperties: false,
});

function languageName(tag: string): string {
  return callTranslationLanguage(tag)?.name ?? tag;
}

/** The model call for one line, charged for the model that served it. */
async function translateLine(
  ctx: PhoneCtx,
  metering: AiMetering | null,
  args: { callId: string; text: string; source: string | null; target: string },
): Promise<{ language: string | null; translation: string }> {
  const res = await generateObject({
    model: createWeldAI(ctx.env).model(TRANSLATE_MODEL),
    schema: lineSchema,
    maxOutputTokens: TRANSLATE_MAX_OUTPUT_TOKENS,
    system: [
      'You interpret a live phone call. You get one spoken sentence, transcribed by a speech recogniser.',
      args.source
        ? `It is spoken in ${languageName(args.source)}.`
        : "Name the language it is spoken in as an ISO 639-1 code (for example 'de') in the field language.",
      `Translate it into ${languageName(args.target)}.`,
      'Keep the meaning, tone, names and numbers. Translate only: add nothing, explain nothing, leave nothing out.',
      args.source ? `Set the field language to '${args.source}'.` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    prompt: args.text,
  });
  await chargeAiUsage(metering, {
    modelId: billedModelId(TRANSLATE_MODEL, res),
    usage: res.usage,
    op: 'call_translate',
    referenceId: args.callId,
  });
  return { language: primaryLanguage(res.object.language), translation: res.object.translation.trim() };
}

interface DetectionTally {
  lang: string;
  n: number;
}

/**
 * Count an utterance towards the caller's language; true once enough
 * confident utterances agree. The tally lives in KV (it spans webhooks); without
 * KV the first confident utterance decides.
 */
async function lockedByDetection(ctx: PhoneCtx, callId: string, lang: string, confident: boolean): Promise<boolean> {
  if (!confident) return false;
  const kv = ctx.env.WORKSPACE_CACHE as Partial<KVNamespace> | undefined;
  if (typeof kv?.get !== 'function' || typeof kv.put !== 'function') return true;
  const key = `desk-call-translation-detect:${callId}`;
  try {
    const raw = await kv.get(key);
    const prev = raw ? (JSON.parse(raw) as DetectionTally) : null;
    const n = prev?.lang === lang ? prev.n + 1 : 1;
    await kv.put(key, JSON.stringify({ lang, n } satisfies DetectionTally), { expirationTtl: DETECTION_TTL_SECONDS });
    return n >= DETECTION_UTTERANCES;
  } catch (err) {
    console.warn('[desk-phone-translation] detection tally unavailable:', err);
    return true;
  }
}

/** Store the detected language on the call and tell the browser. */
async function lockCallerLanguage(ctx: PhoneCtx, call: VoipCallRow, t: VoipCallTranslation, lang: string): Promise<VoipCallTranslation> {
  const next = { ...t, callerLanguage: lang };
  const c = schema.voipCalls;
  await ctx.db
    .update(c)
    .set({ translation: next, updatedAt: new Date() })
    .where(and(eq(c.id, call.id), IS_ACTIVE));
  const event: PhoneTranslationEvent = {
    callId: call.id,
    active: true,
    callerLanguage: lang,
    speakAvailable: speakAvailable(next),
    stoppedReason: null,
  };
  await sendPhoneInboxEvent(ctx.env, ctx.workspaceId, call.answeredByUserId ?? t.startedById, 'phone.translation', event);
  return next;
}

async function recordingEnabled(db: PhoneCtx['db'], toNumber: string): Promise<boolean> {
  const n = schema.voipPhoneNumbers;
  const [row] = await db
    .select({ enableRecording: n.enableRecording })
    .from(n)
    .where(and(eq(n.phoneNumber, toNumber), isNull(n.deletedAt)))
    .limit(1);
  return !!row && row.enableRecording !== false;
}

/** Keep the line on the call's desk conversation as an internal note (original + translation). */
async function recordLine(ctx: PhoneCtx, call: VoipCallRow, caption: PhoneCaptionEvent): Promise<void> {
  if (!call.deskConversationId || !(await recordingEnabled(ctx.db, call.toNumber))) return;
  const saved = await appendDeskMessage(ctx.db, {
    generateId,
    conversationId: call.deskConversationId,
    kind: 'note',
    authorType: 'system',
    body: caption.translation ? `${caption.text}\n${caption.translation}` : caption.text,
    metadata: {
      event: 'call_translation',
      callId: call.id,
      lineId: caption.lineId,
      speaker: caption.speaker,
      original: caption.text,
      translation: caption.translation,
      sourceLanguage: caption.sourceLanguage,
      targetLanguage: caption.targetLanguage,
    },
  });
  await fanoutDeskPhoneMessage({
    env: ctx.env,
    db: ctx.db,
    workspaceId: ctx.workspaceId,
    conversation: saved.conversation,
    message: saved.message,
    action: 'created',
  });
}

/**
 * One `call.transcription` webhook. Final lines of at least two characters only;
 * a line whose translation fails is dropped. Never throws: the webhook must
 * answer 200.
 */
export async function handleCallTranscription(ev: CallTranscriptionEvent): Promise<void> {
  try {
    await processLine(ev);
  } catch (err) {
    console.error('[desk-phone-translation] dropped a line:', err);
  }
}

async function processLine(ev: CallTranscriptionEvent): Promise<void> {
  const data = (ev.payload.transcription_data ?? {}) as TranscriptionData;
  const text = typeof data.transcript === 'string' ? data.transcript.trim() : '';
  const speaker = ev.clientState.translate;
  if (data.is_final !== true || text.length < MIN_LINE_CHARS) return;
  if (speaker !== 'caller' && speaker !== 'agent') return;

  const { ctx } = ev;
  const call = await loadCall(ctx.db, ev.callId);
  let t = call ? activeTranslation(call) : null;
  if (!call || !t) return;

  const source = speaker === 'caller' ? t.callerLanguage : t.agentLanguage;
  const target = speaker === 'caller' ? t.agentLanguage : t.callerLanguage;

  let translation: string | null = null;
  let sourceLanguage = source;
  // Nothing to translate into (the caller's language is unknown), or the same language on both sides.
  const needsModel = target !== null && !(source && primaryLanguage(source) === primaryLanguage(target));
  if (needsModel) {
    try {
      const metering = await resolveAiMetering(ctx.env, ctx.workspaceId, t.startedById);
      await assertAiCredits(metering);
      aiOf(ctx.env);
      const answer = await translateLine(ctx, metering, { callId: call.id, text, source, target });
      translation = answer.translation || null;
      sourceLanguage = source ?? answer.language;
    } catch (err) {
      if (err instanceof InsufficientAiCreditsError) {
        await stopTranslation(ctx, call, { reason: 'no_credits' });
        return;
      }
      console.error('[desk-phone-translation] translation failed, line dropped:', err);
      return;
    }
  }

  // The caller's language was unknown: the model named it; lock it in once enough utterances agree.
  if (speaker === 'caller' && source === null && sourceLanguage) {
    const confidence = typeof data.confidence === 'number' ? data.confidence : 1;
    if (await lockedByDetection(ctx, call.id, sourceLanguage, confidence >= MIN_DETECTION_CONFIDENCE)) {
      t = await lockCallerLanguage(ctx, call, t, sourceLanguage);
    }
    // The caller speaks the agent's language: the text says it all.
    if (primaryLanguage(sourceLanguage) === primaryLanguage(t.agentLanguage)) translation = null;
  }

  const caption: PhoneCaptionEvent = {
    callId: call.id,
    lineId: ev.lineId,
    speaker,
    text,
    translation,
    sourceLanguage,
    targetLanguage: speaker === 'caller' ? t.agentLanguage : t.callerLanguage,
    at: ev.at,
  };
  await sendPhoneInboxEvent(ctx.env, ctx.workspaceId, call.answeredByUserId ?? t.startedById, 'phone.caption', caption);

  const locale = callTranslationTtsLocale(t.callerLanguage);
  if (speaker === 'agent' && translation && t.speakToCaller && locale && call.providerCallId) {
    const control = call.providerCallId;
    await bestEffort('speak translation to the caller', () =>
      telnyxSpeak(ctx.env, control, translation, { voice: PHONE_VOICE, language: locale, targetLegs: 'self' }),
    );
  }
  await bestEffort('record translated line', () => recordLine(ctx, call, caption));
}
