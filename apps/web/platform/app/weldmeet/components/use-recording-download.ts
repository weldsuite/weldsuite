import { useCallback } from 'react';
import { toast } from 'sonner';
import { useRecordingAccess } from '@/hooks/queries/use-weldmeet-recording-queries';
import { getTranslations } from '@/lib/i18n';

/** Start a browser download of a tokenized recording URL (the server answers `?download=1` as an attachment). */
function startDownload(url: string): void {
  const separator = url.includes('?') ? '&' : '?';
  const link = document.createElement('a');
  link.href = `${url}${separator}download=1`;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/**
 * Download a session's recording. A fresh access token is minted on demand for
 * every click; the URL is never kept.
 */
export function useDownloadRecording() {
  const t = getTranslations('weldmeet');
  const access = useRecordingAccess();

  const download = useCallback(
    async (sessionId: string) => {
      try {
        const { url } = await access.mutateAsync(sessionId);
        startDownload(url);
      } catch {
        toast.error(t.recording.actions.downloadFailed);
      }
    },
    [access, t],
  );

  return { download, isDownloading: access.isPending };
}
