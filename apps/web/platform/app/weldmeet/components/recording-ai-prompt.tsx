'use client';

import { useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { useMeetingAiPricing, useSetRecordingAiOptions } from '@/hooks/queries/use-weldmeet-recording-queries';
import { getTranslations } from '@/lib/i18n';
import {
  EMPTY_AI_CHOICE,
  RecordingActionError,
  RecordingAiOptionsFields,
  defaultTranscriptLanguage,
  type RecordingAiChoice,
} from './recording-ai-options';

interface RecordingAiPromptProps {
  sessionId: string;
  onDismiss: () => void;
}

/**
 * Shown to the host when a recording started on its own (auto-record): the
 * server records from the moment the first person joins, so nobody was asked
 * about a transcript or summary. Both stay off unless the host turns them on
 * here; dismissing leaves the meeting as a plain recording.
 */
export function RecordingAiPrompt({ sessionId, onDismiss }: Readonly<RecordingAiPromptProps>) {
  const t = getTranslations('weldmeet');
  const [choice, setChoice] = useState<RecordingAiChoice>({
    ...EMPTY_AI_CHOICE,
    language: defaultTranscriptLanguage(),
  });
  const pricing = useMeetingAiPricing(true);
  const setOptions = useSetRecordingAiOptions();

  const wantsAi = choice.transcribe || choice.summarize;

  const handleSave = () => {
    setOptions.mutate(
      { sessionId, input: choice },
      {
        onSuccess: () => {
          toast.success(t.recording.autoPrompt.saved);
          onDismiss();
        },
      },
    );
  };

  return (
    <section
      aria-label={t.recording.autoPrompt.title}
      className="fixed bottom-24 left-4 z-[60] w-[min(360px,calc(100vw-2rem))] rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-500" aria-hidden />
            {t.recording.autoPrompt.title}
          </h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">{t.recording.autoPrompt.description}</p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="-mr-1 -mt-1 shrink-0"
          onClick={onDismiss}
          aria-label={t.recording.autoPrompt.dismiss}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="mt-3">
        <RecordingAiOptionsFields
          idPrefix="auto-record-prompt"
          value={choice}
          onChange={setChoice}
          pricing={pricing.data}
          pricingLoading={pricing.isLoading}
          pricingFailed={pricing.isError}
          disabled={setOptions.isPending}
        />
      </div>

      {setOptions.isError && (
        <div className="mt-3">
          <RecordingActionError error={setOptions.error} fallback={t.recording.autoPrompt.failed} />
        </div>
      )}

      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onDismiss} disabled={setOptions.isPending}>
          {t.recording.autoPrompt.dismiss}
        </Button>
        <Button size="sm" onClick={handleSave} disabled={!wantsAi || setOptions.isPending}>
          {setOptions.isPending ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
              {t.recording.autoPrompt.saving}
            </>
          ) : (
            t.recording.autoPrompt.save
          )}
        </Button>
      </div>
    </section>
  );
}
