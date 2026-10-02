'use client';

import { Loader2, Sparkles } from 'lucide-react';
import Markdown from 'react-markdown';
import { Button } from '@weldsuite/ui/components/button';
import type { AiJobStatus } from '@weldsuite/app-api-client/schemas/weldmeet-recordings';
import { getTranslations } from '@/lib/i18n';

interface MeetingSummaryPanelProps {
  summaryText: string | null;
  summaryStatus: AiJobStatus | null;
  summaryError: string | null;
  /** A completed transcript exists (the summary is written from it). */
  hasTranscript: boolean;
  /** The transcript is being produced right now. */
  transcriptPending: boolean;
  /** The host asked for a summary at the start; it arrives after the meeting ends. */
  summaryExpected: boolean;
  /** May start a (paid) summary. */
  canGenerate: boolean;
  onGenerate: () => void;
}

function Notice({ title, children }: Readonly<{ title?: string; children: React.ReactNode }>) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      {title && <p className="mb-1 text-sm font-medium text-foreground">{title}</p>}
      <div className="max-w-sm text-xs text-muted-foreground">{children}</div>
    </div>
  );
}

/**
 * The Summary tab of a recorded meeting: the AI summary (markdown) when there
 * is one, otherwise the right next step for where the transcript and summary are.
 */
export function MeetingSummaryPanel({
  summaryText,
  summaryStatus,
  summaryError,
  hasTranscript,
  transcriptPending,
  summaryExpected,
  canGenerate,
  onGenerate,
}: Readonly<MeetingSummaryPanelProps>) {
  const t = getTranslations('weldmeet');

  if (summaryStatus === 'completed' && summaryText) {
    return (
      <div className="py-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t.recording.summary.title}
        </h2>
        <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:font-semibold">
          <Markdown>{summaryText}</Markdown>
        </div>
      </div>
    );
  }

  // Completed, but the text has not been loaded yet (the transcript fetch brings it).
  if (summaryStatus === 'pending' || summaryStatus === 'processing' || summaryStatus === 'completed') {
    return (
      <Notice>
        <span className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          {t.recording.summary.processing}
        </span>
      </Notice>
    );
  }

  const generate = canGenerate && hasTranscript && (
    <Button variant="outline" size="sm" className="mt-4 h-[34px]" onClick={onGenerate}>
      <Sparkles className="mr-1.5 h-3.5 w-3.5" aria-hidden />
      {summaryStatus === 'failed' ? t.recording.summary.retry : t.recording.summary.generate}
    </Button>
  );

  if (summaryStatus === 'failed') {
    return (
      <Notice title={t.recording.summary.failedTitle}>
        <p>{summaryError || t.recording.summary.failedDescription}</p>
        {generate}
      </Notice>
    );
  }

  if (hasTranscript) {
    return (
      <Notice title={t.recording.summary.empty}>
        <p>{t.recording.summary.emptyHint}</p>
        {generate}
      </Notice>
    );
  }

  if (transcriptPending) {
    return (
      <Notice title={t.recording.summary.empty}>
        <p>{t.recording.summary.transcriptPending}</p>
      </Notice>
    );
  }

  return (
    <Notice title={t.recording.summary.empty}>
      <p>{summaryExpected ? t.recording.summary.expected : t.recording.summary.needsTranscript}</p>
    </Notice>
  );
}
