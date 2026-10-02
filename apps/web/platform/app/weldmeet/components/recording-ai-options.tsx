'use client';

import { useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import type { MeetingAiPricingResult } from '@weldsuite/app-api-client/schemas/weldmeet-recordings';
import { getLocale, getTranslations } from '@/lib/i18n';
import { useRouter } from '@/lib/router';
import {
  fillTemplate,
  formatCredits,
  parseInsufficientCredits,
  type InsufficientCreditsDetails,
} from '@/lib/weldmeet/recording';

/** What a host chooses for a recording: transcript, summary and transcript language. */
export interface RecordingAiChoice {
  transcribe: boolean;
  summarize: boolean;
  /** Platform locale / RealtimeKit code; null = auto-detect. */
  language: string | null;
}

export const EMPTY_AI_CHOICE: RecordingAiChoice = { transcribe: false, summarize: false, language: null };

/** Languages RealtimeKit transcribes; anything else is auto-detected. */
const TRANSCRIPT_LANGUAGES = ['en', 'nl', 'de', 'fr', 'sv', 'pl', 'ru', 'el', 'hi'] as const;
const AUTO_LANGUAGE = 'auto';

/** The language to preselect: the user's locale when RealtimeKit supports it, else auto-detect. */
export function defaultTranscriptLanguage(): string | null {
  const locale = getLocale();
  return (TRANSCRIPT_LANGUAGES as readonly string[]).includes(locale) ? locale : null;
}

function languageLabel(code: string): string {
  try {
    return new Intl.DisplayNames([getLocale()], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Whole credits the balance has to cover for the chosen items: one meeting
 * minute of each, which is the gate meet-api applies before enabling them.
 */
export function requiredCreditsForChoice(choice: RecordingAiChoice, pricing: MeetingAiPricingResult): number {
  const perMinute =
    (choice.transcribe ? pricing.transcriptionCreditsPerMinute : 0) +
    (choice.summarize ? pricing.summaryCreditsPerMinute : 0);
  return Math.ceil(perMinute);
}

// ============================================================================
// Not enough credits
// ============================================================================

/** Inline "not enough credits" message with the numbers the API returned and a top-up link. */
export function InsufficientCreditsNotice({ details }: Readonly<{ details: InsufficientCreditsDetails }>) {
  const t = getTranslations('weldmeet');
  const router = useRouter();
  const hasNumbers = details.required !== undefined && details.currentBalance !== undefined;

  return (
    <div
      role="alert"
      className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <p className="font-medium">{t.recording.credits.notEnoughTitle}</p>
      <p className="mt-0.5 text-[13px]">
        {hasNumbers
          ? fillTemplate(t.recording.credits.notEnoughDetail, {
              required: formatCredits(details.required ?? 0),
              balance: formatCredits(details.currentBalance ?? 0),
            })
          : t.recording.credits.notEnough}
      </p>
      <button
        type="button"
        onClick={() => router.push('/settings/billing')}
        className="mt-1.5 text-[13px] font-medium underline underline-offset-2 hover:no-underline"
      >
        {t.recording.credits.topUp}
      </button>
    </div>
  );
}

/** The right inline error for a failed paid action: credits notice for a 402, else the message. */
export function RecordingActionError({
  error,
  fallback,
}: Readonly<{ error: unknown; fallback: string }>) {
  const credits = parseInsufficientCredits(error);
  if (credits) return <InsufficientCreditsNotice details={credits} />;
  const message = error instanceof Error && error.message ? error.message : fallback;
  return (
    <p role="alert" className="text-sm text-destructive">
      {message}
    </p>
  );
}

// ============================================================================
// Fields
// ============================================================================

interface RecordingAiOptionsFieldsProps {
  value: RecordingAiChoice;
  onChange: (next: RecordingAiChoice) => void;
  pricing: MeetingAiPricingResult | undefined;
  pricingLoading: boolean;
  pricingFailed: boolean;
  disabled?: boolean;
  /** Prefix for the input ids, so two instances never share one. */
  idPrefix: string;
}

/**
 * "Transcribe this meeting" / "Generate AI summary" checkboxes with the
 * per-minute credit cost, the wallet balance and the transcript language.
 * Shared by the start-recording dialog and the auto-record prompt.
 */
export function RecordingAiOptionsFields({
  value,
  onChange,
  pricing,
  pricingLoading,
  pricingFailed,
  disabled = false,
  idPrefix,
}: Readonly<RecordingAiOptionsFieldsProps>) {
  const t = getTranslations('weldmeet');
  const unavailable = pricingFailed && !pricing;
  const locked = disabled || unavailable;

  const lowBalance = useMemo(
    () =>
      pricing && (value.transcribe || value.summarize)
        ? pricing.balance < requiredCreditsForChoice(value, pricing)
        : false,
    [pricing, value],
  );

  const setTranscribe = (checked: boolean) =>
    onChange({ ...value, transcribe: checked, summarize: checked ? value.summarize : false });
  // A summary is written from the transcript, so choosing it turns the transcript on.
  const setSummarize = (checked: boolean) =>
    onChange({ ...value, summarize: checked, transcribe: checked ? true : value.transcribe });

  const rate = (credits: number | undefined) =>
    credits === undefined
      ? null
      : fillTemplate(credits === 1 ? t.recording.ai.perMinuteOne : t.recording.ai.perMinute, {
          credits: formatCredits(credits),
        });

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <Checkbox
          id={`${idPrefix}-transcribe`}
          checked={value.transcribe}
          onCheckedChange={(checked) => setTranscribe(checked === true)}
          disabled={locked}
          className="mt-0.5"
        />
        <div className="min-w-0 flex-1">
          <Label htmlFor={`${idPrefix}-transcribe`} className="text-sm font-medium">
            {t.recording.ai.transcribeLabel}
          </Label>
          <p className="text-[13px] text-muted-foreground">{t.recording.ai.transcribeHelp}</p>
          {rate(pricing?.transcriptionCreditsPerMinute) && (
            <p className="mt-0.5 text-[13px] font-medium text-foreground/80">
              {rate(pricing?.transcriptionCreditsPerMinute)}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-start gap-3">
        <Checkbox
          id={`${idPrefix}-summarize`}
          checked={value.summarize}
          onCheckedChange={(checked) => setSummarize(checked === true)}
          disabled={locked}
          className="mt-0.5"
        />
        <div className="min-w-0 flex-1">
          <Label htmlFor={`${idPrefix}-summarize`} className="text-sm font-medium">
            {t.recording.ai.summarizeLabel}
          </Label>
          <p className="text-[13px] text-muted-foreground">{t.recording.ai.summarizeHelp}</p>
          {rate(pricing?.summaryCreditsPerMinute) && (
            <p className="mt-0.5 text-[13px] font-medium text-foreground/80">
              {rate(pricing?.summaryCreditsPerMinute)}
            </p>
          )}
        </div>
      </div>

      {value.transcribe && (
        <div className="space-y-1.5 pl-7">
          <Label htmlFor={`${idPrefix}-language`} className="text-[13px] text-muted-foreground">
            {t.recording.ai.language}
          </Label>
          <Select
            value={value.language ?? AUTO_LANGUAGE}
            onValueChange={(next) => onChange({ ...value, language: next === AUTO_LANGUAGE ? null : next })}
            disabled={disabled}
          >
            <SelectTrigger id={`${idPrefix}-language`} size="sm" className="w-full sm:w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO_LANGUAGE}>{t.recording.ai.languageAuto}</SelectItem>
              {TRANSCRIPT_LANGUAGES.map((code) => (
                <SelectItem key={code} value={code}>
                  {languageLabel(code)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="space-y-1 text-[13px] text-muted-foreground">
        {pricingLoading && !pricing && (
          <p className="flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            {t.recording.ai.pricingLoading}
          </p>
        )}
        {unavailable && !pricingLoading && <p>{t.recording.ai.pricingUnavailable}</p>}
        {pricing && (
          <p>{fillTemplate(t.recording.ai.balance, { credits: formatCredits(pricing.balance) })}</p>
        )}
        {lowBalance && <p className="text-amber-700 dark:text-amber-400">{t.recording.ai.lowBalance}</p>}
        {pricing && <p>{t.recording.ai.chargeNote}</p>}
      </div>
    </div>
  );
}
