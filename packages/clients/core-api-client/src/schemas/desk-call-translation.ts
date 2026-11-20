import { z } from 'zod';

// ── WeldDesk live call translation (/api/desk/phone/calls/:callId/translation) ──
//
// An agent on a live inbound call switches Translate on: both sides' speech is
// transcribed, translated, shown as captions in the agent's browser (realtime
// event `phone.caption`) and, optionally, the agent's words are spoken to the
// caller in the caller's language. Global only (feature `desk-ai`): without an
// AI provider the routes answer 503 `ai_unavailable`.

/** One language the call translation offers. */
export interface CallTranslationLanguage {
  /** Primary language tag: `nl`, `zh`. */
  code: string;
  /** English name (the picker shows localised names from the i18n files). */
  name: string;
  /** Telnyx basic `speak` locale, or null when the language is captions-only. */
  ttsLocale: string | null;
}

export const CALL_TRANSLATION_LANGUAGES: readonly CallTranslationLanguage[] = [
  { code: 'en', name: 'English', ttsLocale: 'en-US' },
  { code: 'nl', name: 'Dutch', ttsLocale: 'nl-NL' },
  { code: 'de', name: 'German', ttsLocale: 'de-DE' },
  { code: 'fr', name: 'French', ttsLocale: 'fr-FR' },
  { code: 'es', name: 'Spanish', ttsLocale: 'es-ES' },
  { code: 'it', name: 'Italian', ttsLocale: 'it-IT' },
  { code: 'pt', name: 'Portuguese', ttsLocale: 'pt-PT' },
  { code: 'pl', name: 'Polish', ttsLocale: 'pl-PL' },
  { code: 'tr', name: 'Turkish', ttsLocale: 'tr-TR' },
  { code: 'ar', name: 'Arabic', ttsLocale: 'arb' },
  { code: 'ru', name: 'Russian', ttsLocale: 'ru-RU' },
  { code: 'uk', name: 'Ukrainian', ttsLocale: null },
  { code: 'ro', name: 'Romanian', ttsLocale: 'ro-RO' },
  { code: 'sv', name: 'Swedish', ttsLocale: 'sv-SE' },
  { code: 'da', name: 'Danish', ttsLocale: 'da-DK' },
  { code: 'nb', name: 'Norwegian', ttsLocale: 'nb-NO' },
  { code: 'hi', name: 'Hindi', ttsLocale: 'hi-IN' },
  { code: 'zh', name: 'Chinese', ttsLocale: 'cmn-CN' },
  { code: 'ja', name: 'Japanese', ttsLocale: 'ja-JP' },
  { code: 'ko', name: 'Korean', ttsLocale: 'ko-KR' },
];

const CODES = CALL_TRANSLATION_LANGUAGES.map((l) => l.code) as [string, ...string[]];

/** `pt-BR` → `pt`; null when there is nothing to read. */
export function primaryLanguage(tag: string | null | undefined): string | null {
  const primary = (tag ?? '').trim().toLowerCase().split('-')[0] ?? '';
  return primary || null;
}

/** The offered language for a tag (`nb-NO` → Norwegian), or undefined. `no` counts as `nb`. */
export function callTranslationLanguage(tag: string | null | undefined): CallTranslationLanguage | undefined {
  const primary = primaryLanguage(tag);
  const code = primary === 'no' ? 'nb' : primary;
  return CALL_TRANSLATION_LANGUAGES.find((l) => l.code === code);
}

/** The Telnyx `speak` locale for a language, or null when it can only be captioned. */
export function callTranslationTtsLocale(tag: string | null | undefined): string | null {
  return callTranslationLanguage(tag)?.ttsLocale ?? null;
}

export const callTranslationLanguageCodeSchema = z.enum(CODES);

/** `POST /api/desk/phone/calls/:callId/translation`. */
export const startCallTranslationSchema = z.object({
  /** The caller's language, or `auto` to detect it from their first words. */
  callerLanguage: z.union([z.literal('auto'), callTranslationLanguageCodeSchema]),
  /** The language the agent reads and speaks. */
  agentLanguage: callTranslationLanguageCodeSchema,
  /** Speak the agent's translated words to the caller (default on; needs a spoken voice for their language). */
  speakToCaller: z.boolean().optional(),
});

/** `PATCH /api/desk/phone/calls/:callId/translation`. */
export const updateCallTranslationSchema = startCallTranslationSchema.partial();

/** The translation of a call, as the routes answer it. */
export const callTranslationStateSchema = z
  .object({
    callId: z.string(),
    active: z.boolean(),
    /** Null while the caller's language is still being detected. */
    callerLanguage: z.string().nullable(),
    agentLanguage: z.string(),
    speakToCaller: z.boolean(),
    /** Whether the agent's words can be spoken to the caller (a voice exists for their language). */
    speakAvailable: z.boolean(),
    startedAt: z.string(),
    startedById: z.string(),
    stoppedAt: z.string().nullable(),
  })
  .strict();

/** Why a request on a call's translation was refused (409 `details.reason`). */
export const CALL_TRANSLATION_REFUSALS = ['not_live', 'not_your_call', 'already_translating', 'not_translating'] as const;
export type CallTranslationRefusal = (typeof CALL_TRANSLATION_REFUSALS)[number];

/**
 * Realtime event `phone.caption` on topic `inbox.<userId>`: one finished line
 * of the call. `translation` is null when there is nothing to show beside the
 * text (both sides speak one language, or the caller's language is not known yet).
 */
export const phoneCaptionEventSchema = z.object({
  callId: z.string(),
  lineId: z.string(),
  speaker: z.enum(['caller', 'agent']),
  text: z.string(),
  translation: z.string().nullable(),
  sourceLanguage: z.string().nullable(),
  targetLanguage: z.string().nullable(),
  /** ISO time of the line. */
  at: z.string(),
});

/** Realtime event `phone.translation` on `inbox.<userId>`: the translation changed under the agent. */
export const phoneTranslationEventSchema = z.object({
  callId: z.string(),
  active: z.boolean(),
  callerLanguage: z.string().nullable(),
  speakAvailable: z.boolean(),
  /** Set when the system stopped it: `no_credits` or `call_ended`. */
  stoppedReason: z.enum(['no_credits', 'call_ended']).nullable(),
});

export type StartCallTranslation = z.infer<typeof startCallTranslationSchema>;
export type UpdateCallTranslation = z.infer<typeof updateCallTranslationSchema>;
export type CallTranslationState = z.infer<typeof callTranslationStateSchema>;
export type PhoneCaptionEvent = z.infer<typeof phoneCaptionEventSchema>;
export type PhoneTranslationEvent = z.infer<typeof phoneTranslationEventSchema>;
