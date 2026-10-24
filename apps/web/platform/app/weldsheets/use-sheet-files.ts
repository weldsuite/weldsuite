/**
 * Imports in the UI: what an import says when it is done or fails, and
 * opening a WeldDrive file (.xlsx, .csv, .tsv) as a new spreadsheet.
 */

import { useCallback } from 'react';
import { toast } from 'sonner';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useCan } from '@weldsuite/permissions/react';
import type { SheetFileLocale, SheetImportWarning } from '@weldsuite/app-api-client/schemas/sheets';
import { useIsAppInstalled } from '@/hooks/use-is-app-installed';
import { useAppApi } from '@/lib/api/use-app-api';
import { useI18n } from '@/lib/i18n/provider';
import { importFailure } from './files';
import { sheetsQueryKey } from './store/use-sheet-store';

type I18n = ReturnType<typeof useI18n>;
type FileStrings = I18n['t']['weldsheets']['files'];

/** The language a file is read in: the reader's own. */
export function fileLocale(language: string): SheetFileLocale {
  return language === 'nl' ? 'nl' : 'en';
}

/** "Imported X", saying what the file had that the spreadsheet does not. */
export function announceImport(name: string, warnings: SheetImportWarning[], tf: FileStrings, format: I18n['format']): void {
  const list = warnings.map((w) => tf.warnings[w]).join(', ');
  if (list) toast.warning(format(tf.imported, { name }), { description: format(tf.leftOut, { list }) });
  else toast.success(format(tf.imported, { name }));
}

export function announceImportFailure(err: unknown, name: string, tf: FileStrings, format: I18n['format']): void {
  const reasons = { too_large: tf.tooLarge, unsupported: tf.unsupported, not_spreadsheet: tf.notSpreadsheet, corrupt: tf.corrupt, empty: tf.empty };
  const reason = importFailure(err);
  toast.error(format(tf.failed, { name }), reason ? { description: reasons[reason] } : undefined);
}

/**
 * Makes a new spreadsheet from a WeldDrive file and opens it (the file stays
 * as it is). Null where the workspace has no WeldSheets or the caller may not
 * create spreadsheets.
 */
export function useOpenInWeldSheets(): ((file: { id: string; name: string }) => Promise<void>) | null {
  const installed = useIsAppInstalled('weldsheets');
  const canCreate = useCan('sheets:create');
  const appApi = useAppApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t, format, language } = useI18n();
  const tf = t.weldsheets.files;

  const open = useCallback(
    async (file: { id: string; name: string }) => {
      const pending = toast.loading(format(tf.importing, { name: file.name }));
      try {
        const { data } = await appApi.sheets.importDriveFile({ fileId: file.id, locale: fileLocale(language) });
        toast.dismiss(pending);
        announceImport(data.sheet.name, data.warnings, tf, format);
        void queryClient.invalidateQueries({ queryKey: sheetsQueryKey });
        await navigate({ to: '/weldsheets/$sheetId', params: { sheetId: data.sheet.id } });
      } catch (err) {
        toast.dismiss(pending);
        announceImportFailure(err, file.name, tf, format);
      }
    },
    [appApi.sheets, format, language, navigate, queryClient, tf],
  );
  return installed && canCreate ? open : null;
}
