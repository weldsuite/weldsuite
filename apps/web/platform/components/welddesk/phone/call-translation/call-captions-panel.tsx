import { useEffect, useRef } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import type { PhoneCaptionEvent } from '@weldsuite/core-api-client/schemas/desk-call-translation';
import { cn } from '@/lib/utils';
import { getTranslations } from '@/lib/i18n';
import { languageName } from './call-translation-labels';

/** One line: who spoke, what was said in small type, its translation prominent. */
function CaptionLine({ line }: Readonly<{ line: PhoneCaptionEvent }>) {
  const t = getTranslations('deskCallTranslation').panel;
  const fromCaller = line.speaker === 'caller';
  return (
    <li
      className={cn('rounded-md px-2.5 py-1.5', fromCaller ? 'bg-muted/60' : 'bg-primary/10')}
      data-testid="call-caption-line"
      data-speaker={line.speaker}
    >
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {fromCaller ? t.caller : t.you}
      </p>
      {line.translation ? (
        <>
          <p className="text-sm font-medium" data-testid="call-caption-translation">
            {line.translation}
          </p>
          <p className="text-xs text-muted-foreground" data-testid="call-caption-original">
            {line.text}
          </p>
        </>
      ) : (
        <p className="text-sm font-medium" data-testid="call-caption-text">
          {line.text}
        </p>
      )}
    </li>
  );
}

/** What the voice note under the title says: whether the agent's words reach the caller. */
function voiceNoteOf(
  t: ReturnType<typeof getTranslations<'deskCallTranslation'>>['panel'],
  callerLanguage: string | null,
  speakAvailable: boolean,
  speakToCaller: boolean,
): string | null {
  if (!callerLanguage) return null;
  if (!speakAvailable) return t.captionsOnly;
  return speakToCaller ? t.spoken : t.notSpoken;
}

/**
 * The live captions of a translated call: the lines as they arrive (scrolled to
 * the newest), the caller's language once it is known, and Change and Stop.
 */
export function CallCaptionsPanel({
  lines,
  callerLanguage,
  speakAvailable,
  speakToCaller,
  stopping,
  onChange,
  onStop,
}: Readonly<{
  lines: PhoneCaptionEvent[];
  callerLanguage: string | null;
  speakAvailable: boolean;
  speakToCaller: boolean;
  stopping: boolean;
  onChange: () => void;
  onStop: () => void;
}>) {
  const labels = getTranslations('deskCallTranslation');
  const t = labels.panel;
  const logRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const languageNote = callerLanguage
    ? t.detected.replace('{language}', languageName(labels, callerLanguage))
    : t.detecting;
  const voiceNote = voiceNoteOf(t, callerLanguage, speakAvailable, speakToCaller);

  return (
    <section className="w-full rounded-lg border p-3" data-testid="call-captions-panel" aria-label={t.title}>
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{t.title}</h3>
          <p className="truncate text-xs text-muted-foreground" data-testid="call-captions-language">
            {languageNote}
          </p>
          {voiceNote && (
            <p className="truncate text-xs text-muted-foreground" data-testid="call-captions-voice">
              {voiceNote}
            </p>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onChange} data-testid="call-captions-change">
          {t.change}
        </Button>
      </div>

      <ul
        ref={logRef}
        role="log"
        aria-live="polite"
        className="mb-3 max-h-48 space-y-1.5 overflow-y-auto"
        data-testid="call-captions-log"
      >
        {lines.length === 0 ? (
          <li className="text-xs text-muted-foreground" data-testid="call-captions-empty">
            {t.waiting}
          </li>
        ) : (
          lines.map((line) => <CaptionLine key={line.lineId} line={line} />)
        )}
      </ul>

      <Button
        variant="outline"
        size="sm"
        className="w-full"
        onClick={onStop}
        disabled={stopping}
        data-testid="call-captions-stop"
      >
        {labels.action.stop}
      </Button>
    </section>
  );
}

/** Why the system stopped the translation, as a banner. */
export function CallTranslationStoppedBanner({ reason }: Readonly<{ reason: 'no_credits' | 'call_ended' | null }>) {
  const t = getTranslations('deskCallTranslation').panel;
  let message: string = t.stopped;
  if (reason === 'no_credits') message = t.stoppedNoCredits;
  else if (reason === 'call_ended') message = t.stoppedCallEnded;
  return (
    <InfoBanner variant={reason === 'no_credits' ? 'warning' : 'neutral'} data-testid="call-translation-stopped">
      {message}
    </InfoBanner>
  );
}
