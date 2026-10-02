'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { useMeetingAiPricing } from '@/hooks/queries/use-weldmeet-recording-queries';
import { getTranslations } from '@/lib/i18n';
import {
  EMPTY_AI_CHOICE,
  RecordingActionError,
  RecordingAiOptionsFields,
  defaultTranscriptLanguage,
  type RecordingAiChoice,
} from './recording-ai-options';

interface StartRecordingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the server already has for this meeting (a previous choice), if anything. */
  initial: RecordingAiChoice | null;
  /** Starts the recording with the choice. Reject to keep the dialog open and show the error. */
  onConfirm: (choice: RecordingAiChoice) => Promise<void>;
}

/**
 * Opened when the host presses Record. Recording itself is always offered;
 * transcript and AI summary are opt-in (off by default), with their credit
 * cost per meeting minute and the current balance beside them.
 */
export function StartRecordingDialog({ open, onOpenChange, initial, onConfirm }: Readonly<StartRecordingDialogProps>) {
  const t = getTranslations('weldmeet');
  const [choice, setChoice] = useState<RecordingAiChoice>(EMPTY_AI_CHOICE);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const pricing = useMeetingAiPricing(open);

  // Fresh state each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSubmitting(false);
    setChoice(
      initial && (initial.transcribe || initial.summarize)
        ? initial
        : { ...EMPTY_AI_CHOICE, language: initial?.language ?? defaultTranscriptLanguage() },
    );
    // Only on open: later server updates must not overwrite what the host is picking.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleStart = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(choice);
      onOpenChange(false);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={submitting ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t.recording.startDialog.title}</DialogTitle>
          <DialogDescription>{t.recording.startDialog.description}</DialogDescription>
        </DialogHeader>

        <RecordingAiOptionsFields
          idPrefix="start-recording"
          value={choice}
          onChange={setChoice}
          pricing={pricing.data}
          pricingLoading={pricing.isLoading}
          pricingFailed={pricing.isError}
          disabled={submitting}
        />

        {error !== null && <RecordingActionError error={error} fallback={t.recording.startDialog.failed} />}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t.recording.startDialog.cancel}
          </Button>
          <Button onClick={handleStart} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                {t.recording.startDialog.starting}
              </>
            ) : (
              t.recording.startDialog.start
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
