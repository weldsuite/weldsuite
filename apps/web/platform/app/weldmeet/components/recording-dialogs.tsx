'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  useDeleteRecording,
  useMeetingAiPricing,
  useSummarizeRecording,
  useTranscribeRecording,
} from '@/hooks/queries/use-weldmeet-recording-queries';
import { getTranslations } from '@/lib/i18n';
import {
  billedMinutes,
  estimateCredits,
  fillTemplate,
  formatCredits,
  hasApiStatus,
} from '@/lib/weldmeet/recording';
import { RecordingActionError } from './recording-ai-options';

// ============================================================================
// Transcribe / summarize with a cost estimate
// ============================================================================

export type RecordingAiKind = 'transcribe' | 'summarize';

interface RecordingAiEstimateDialogProps {
  open: boolean;
  kind: RecordingAiKind;
  sessionId: string;
  /** Meeting seconds the run is billed for (already capped at the session length); null when unknown. */
  seconds: number | null;
  onOpenChange: (open: boolean) => void;
  /** Called once the transcript / summary run was accepted by the API. */
  onStarted?: () => void;
}

/**
 * Confirms a paid "transcribe afterwards" / "summarize" run: shows the estimate
 * (minutes x credits per minute), the wallet balance and, when the API answers
 * 402, a clear not-enough-credits message instead of a generic failure.
 */
export function RecordingAiEstimateDialog({
  open,
  kind,
  sessionId,
  seconds,
  onOpenChange,
  onStarted,
}: Readonly<RecordingAiEstimateDialogProps>) {
  const t = getTranslations('weldmeet');
  const pricing = useMeetingAiPricing(open);
  const transcribe = useTranscribeRecording();
  const summarize = useSummarizeRecording();
  const mutation = kind === 'transcribe' ? transcribe : summarize;
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const rate =
    kind === 'transcribe'
      ? pricing.data?.transcriptionCreditsPerMinute
      : pricing.data?.summaryCreditsPerMinute;
  const minutes = billedMinutes(seconds);
  const estimate = rate !== undefined && minutes > 0 ? estimateCredits(minutes, rate) : null;

  const handleConfirm = async () => {
    setError(null);
    try {
      const result =
        kind === 'transcribe'
          ? await transcribe.mutateAsync({ sessionId })
          : await summarize.mutateAsync(sessionId);
      if (result.status === 'existing') toast.info(t.recording.estimate.alreadyExists);
      else toast.success(kind === 'transcribe' ? t.recording.estimate.transcribeStarted : t.recording.estimate.summarizeStarted);
      onStarted?.();
      onOpenChange(false);
    } catch (err) {
      setError(err);
    }
  };

  const pending = mutation.isPending;
  const failedFallback =
    kind === 'transcribe' ? t.recording.estimate.transcribeFailed : t.recording.estimate.summarizeFailed;

  return (
    <Dialog open={open} onOpenChange={pending ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>
            {kind === 'transcribe' ? t.recording.estimate.transcribeTitle : t.recording.estimate.summarizeTitle}
          </DialogTitle>
          <DialogDescription>
            {kind === 'transcribe'
              ? t.recording.estimate.transcribeDescription
              : t.recording.estimate.summarizeDescription}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5 text-sm">
          {pricing.isLoading && (
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              {t.recording.ai.pricingLoading}
            </p>
          )}
          {estimate !== null && rate !== undefined && (
            <p className="font-medium">
              {fillTemplate(t.recording.estimate.cost, {
                credits: formatCredits(estimate),
                minutes,
                rate: formatCredits(rate),
              })}
            </p>
          )}
          {estimate === null && rate !== undefined && (
            <p className="font-medium">
              {fillTemplate(t.recording.estimate.costUnknown, { rate: formatCredits(rate) })}
            </p>
          )}
          {pricing.data && (
            <p className="text-[13px] text-muted-foreground">
              {fillTemplate(t.recording.estimate.balance, { credits: formatCredits(pricing.data.balance) })}
            </p>
          )}
          {pricing.isError && <p className="text-[13px] text-muted-foreground">{t.recording.ai.pricingUnavailable}</p>}
        </div>

        {error !== null && <RecordingActionError error={error} fallback={failedFallback} />}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {t.recording.startDialog.cancel}
          </Button>
          <Button onClick={handleConfirm} disabled={pending || pricing.isLoading}>
            {pending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />}
            {kind === 'transcribe' ? t.recording.estimate.confirmTranscribe : t.recording.estimate.confirmSummarize}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Delete recording
// ============================================================================

interface DeleteRecordingDialogProps {
  open: boolean;
  sessionId: string;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}

/** Confirms deleting a recording: video, audio, transcript and summary all go. */
export function DeleteRecordingDialog({
  open,
  sessionId,
  onOpenChange,
  onDeleted,
}: Readonly<DeleteRecordingDialogProps>) {
  const t = getTranslations('weldmeet');
  const deleteRecording = useDeleteRecording();

  const handleConfirm = async () => {
    try {
      await deleteRecording.mutateAsync(sessionId);
      toast.success(t.recording.delete.deleted);
      onDeleted?.();
      onOpenChange(false);
    } catch (err) {
      // 409: the recorder is still running. Everything else: say it failed.
      toast.error(hasApiStatus(err, 409) ? t.recording.delete.stillRecording : t.recording.delete.failed);
      onOpenChange(false);
    }
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t.recording.delete.title}
      description={t.recording.delete.description}
      confirmLabel={t.recording.delete.confirm}
      variant="destructive"
      loading={deleteRecording.isPending}
      onConfirm={handleConfirm}
    />
  );
}
