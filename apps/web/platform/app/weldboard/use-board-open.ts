/**
 * Opening a WeldDrive file as a new board: an Excalidraw scene (.excalidraw)
 * or WeldBoard's own export (.weldboard.json). The file stays as it is in
 * WeldDrive; the board is a new drive file next to the others in My Drive.
 */

import { useCallback } from 'react';
import { toast } from 'sonner';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useCan } from '@weldsuite/permissions/react';
import { WELDBOARD_MIME_TYPE } from '@weldsuite/app-api-client/schemas/boards';
import { usePreviewMode } from '@/contexts/preview-mode-context';
import { useIsAppInstalled } from '@/hooks/use-is-app-installed';
import { useAuth } from '@/lib/auth';
import { useAppApi } from '@/lib/api/use-app-api';
import { apiUrl } from '@/lib/api/public-env';
import { useI18n } from '@/lib/i18n/provider';
import { boardName, importFormat, IMPORT_MAX_BYTES } from './import';
import { boardsQueryKey } from './store/use-board-store';

/** A WeldDrive file WeldBoard can open as a new board (a board itself opens as it is). */
export function canOpenInWeldBoard(file: { name: string; source?: string; mimeType?: string | null }): boolean {
  if (file.source !== 'drive' || file.mimeType === WELDBOARD_MIME_TYPE) return false;
  const kind = importFormat(file.name);
  return kind === 'excalidraw' || kind === 'weldboard';
}

/** Opens a drive file as a new board and goes to it; null where boards cannot be made. */
export function useOpenInWeldBoard(): ((file: { id: string; name: string; fileSize?: number | null }) => Promise<void>) | null {
  const installed = useIsAppInstalled('weldboard');
  const canCreate = useCan('boards:create');
  const preview = usePreviewMode();
  const appApi = useAppApi();
  const { getToken } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t, format } = useI18n();
  const th = t.weldboard.home;

  const open = useCallback(
    async (file: { id: string; name: string; fileSize?: number | null }) => {
      const kind = importFormat(file.name);
      if (!kind || (file.fileSize ?? 0) > IMPORT_MAX_BYTES) {
        toast.error(format(th.importFailed, { name: file.name }));
        return;
      }
      const pending = toast.loading(format(th.importing, { name: file.name }));
      try {
        const token = await getToken();
        const res = await fetch(apiUrl(`/api/files/${encodeURIComponent(file.id)}/content`), { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const content = await res.text();
        if (content.length > IMPORT_MAX_BYTES) throw new Error('too large');
        const { data } = await appApi.boards.import({ name: boardName(file.name), format: kind, content });
        toast.dismiss(pending);
        if (data.skipped) toast.warning(format(th.imported, { name: file.name }), { description: format(th.importSkipped, { count: data.skipped }) });
        else toast.success(format(th.imported, { name: file.name }));
        void queryClient.invalidateQueries({ queryKey: boardsQueryKey });
        await navigate({ to: '/weldboard/$boardId', params: { boardId: data.id } });
      } catch {
        toast.dismiss(pending);
        toast.error(format(th.importFailed, { name: file.name }));
      }
    },
    [appApi.boards, format, getToken, navigate, queryClient, th],
  );
  return installed && canCreate && !preview ? open : null;
}
