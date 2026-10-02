'use client';

import { AlertCircle, Clock, Loader2, Lock, Trash2, Video } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import type { RecordingStatus } from '@weldsuite/app-api-client/schemas/weldmeet-recordings';
import { getTranslations } from '@/lib/i18n';

type PanelKind = RecordingStatus | 'forbidden' | 'loadFailed';

interface RecordingStatePanelProps {
  kind: PanelKind;
  /** Server-side failure reason, shown under a failed recording. */
  error?: string | null;
  onRetry?: () => void;
}

/**
 * Stands in for the video player while there is nothing to play: the meeting
 * is still being recorded, the file is processing, it failed or expired, or it
 * was deleted. Never a blank player.
 */
export function RecordingStatePanel({ kind, error, onRetry }: Readonly<RecordingStatePanelProps>) {
  const t = getTranslations('weldmeet');

  const content = (() => {
    switch (kind) {
      case 'recording':
        return { icon: <Video className="h-5 w-5" />, title: t.recording.state.recordingTitle, description: t.recording.state.recordingDescription };
      case 'processing':
        return { icon: <Loader2 className="h-5 w-5 animate-spin" />, title: t.recording.state.processingTitle, description: t.recording.state.processingDescription };
      case 'failed':
        return { icon: <AlertCircle className="h-5 w-5" />, title: t.recording.state.failedTitle, description: error || t.recording.state.failedDescription };
      case 'unavailable':
        return { icon: <Clock className="h-5 w-5" />, title: t.recording.state.unavailableTitle, description: t.recording.state.unavailableDescription };
      case 'deleted':
        return { icon: <Trash2 className="h-5 w-5" />, title: t.recording.state.deletedTitle, description: t.recording.state.deletedDescription };
      case 'forbidden':
        return { icon: <Lock className="h-5 w-5" />, title: t.recording.state.noPermission, description: null };
      case 'loadFailed':
        return { icon: <AlertCircle className="h-5 w-5" />, title: t.recording.state.loadFailed, description: null };
      default:
        return { icon: <Video className="h-5 w-5" />, title: t.recording.state.processingTitle, description: null };
    }
  })();

  return (
    <div
      role="status"
      className="m-4 flex flex-col items-center justify-center rounded-xl border border-dashed bg-muted/30 px-6 py-10 text-center"
    >
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {content.icon}
      </div>
      <p className="text-sm font-medium text-foreground">{content.title}</p>
      {content.description && <p className="mt-1 max-w-md text-xs text-muted-foreground">{content.description}</p>}
      {kind === 'loadFailed' && onRetry && (
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
          {t.recording.state.retry}
        </Button>
      )}
    </div>
  );
}
