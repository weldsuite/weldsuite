import { Loader2 } from 'lucide-react';
import type { RecordingStatus } from '@weldsuite/app-api-client/schemas/weldmeet-recordings';
import { cn } from '@/lib/utils';
import { getTranslations } from '@/lib/i18n';

const STATUS_STYLES: Record<RecordingStatus, string> = {
  recording: 'bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400',
  processing: 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400',
  ready: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400',
  failed: 'bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400',
  unavailable: 'bg-gray-100 text-gray-600 dark:bg-secondary dark:text-muted-foreground',
  deleted: 'bg-gray-100 text-gray-600 dark:bg-secondary dark:text-muted-foreground',
};

/**
 * Recording state chip for the history list: recording / processing / ready /
 * failed / expired. A legacy row with no recorder state yet (`null`) shows the
 * neutral "Recorded" label, since nothing more is known about it.
 */
export function RecordingStatusBadge({ status }: Readonly<{ status: RecordingStatus | null | undefined }>) {
  const t = getTranslations('weldmeet');

  if (status === null || status === undefined) {
    return (
      <span className="flex items-center gap-1 rounded-[6px] bg-red-50 px-2 py-[4px] text-[12px] font-medium text-red-600 dark:bg-red-950 dark:text-red-400">
        <div className="h-1.5 w-1.5 rounded-full bg-red-500" />
        {t.historyPage.recorded}
      </span>
    );
  }

  const busy = status === 'recording' || status === 'processing';
  return (
    <span
      className={cn(
        'flex items-center gap-1 whitespace-nowrap rounded-[6px] px-2 py-[4px] text-[12px] font-medium',
        STATUS_STYLES[status],
      )}
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
      ) : (
        <div className="h-1.5 w-1.5 rounded-full bg-current" />
      )}
      {t.recording.status[status]}
    </span>
  );
}
