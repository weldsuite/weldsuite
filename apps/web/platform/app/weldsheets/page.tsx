import { useCallback } from 'react';
import { toast } from 'sonner';
import { useNavigate } from '@tanstack/react-router';
import { useCan } from '@weldsuite/permissions/react';
import { SHEET_IMPORT_MAX_BYTES } from '@weldsuite/app-api-client/schemas/sheets';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { EmptyStateIllustration } from '@/components/entity-list';
import { NewFileStrip } from '@/components/office-home/new-file-strip';
import { OfficeFileList } from '@/components/office-home/office-file-list';
import { usePreviewMode } from '@/contexts/preview-mode-context';
import { useI18n } from '@/lib/i18n/provider';
import { IMPORT_ACCEPT } from './files';
import { useSheetList, useSheetMutations, type SheetMeta } from './store/use-sheet-store';
import { announceImport, announceImportFailure, fileLocale } from './use-sheet-files';

const NO_SHEETS: SheetMeta[] = [];

/** WeldSheets home, laid out like WeldBoard's: a strip to start a spreadsheet, then the standard list. */
export default function WeldSheetsHome() {
  const { t } = useI18n();
  const th = t.weldsheets.home;
  const tf = t.weldsheets.files;
  const preview = usePreviewMode();
  const sheets = useSheetList();
  const { create } = useSheetMutations();
  const canCreate = useCan('sheets:create');
  const actions = useSheetActions();
  const open = useOpenSheet();
  const importFile = useSheetImport(open);

  const createBlank = () => {
    if (create.isPending) return;
    // A failed create leaves nothing to open.
    void create.mutateAsync({ name: th.untitled, firstTabName: th.firstTab }).then(open, () => undefined);
  };

  if (sheets.isLoading) return <PageLoader fullScreen={false} />;

  return (
    <div className="flex w-full flex-col">
      {canCreate && (
        <NewFileStrip
          title={th.startNew}
          blankLabel={th.blank}
          importLabel={tf.importFile}
          importHint={tf.importHint}
          accept={IMPORT_ACCEPT}
          onBlank={createBlank}
          onImport={(file) => void importFile(file)}
        />
      )}
      {sheets.isError && !sheets.data ? (
        <ErrorState message={th.loadFailed} onRetry={() => void sheets.refetch()} retryLabel={th.retry} className="py-16" />
      ) : (
        <OfficeFileList
          files={sheets.data ?? NO_SHEETS}
          labels={th}
          createLabel={th.newSheet}
          illustration={<SheetsIllustration />}
          onOpen={open}
          {...actions}
          onCreate={canCreate ? createBlank : undefined}
          notice={preview ? <span className="text-xs text-muted-foreground">{th.localNotice}</span> : undefined}
          emptyStateClassName="min-h-[360px] py-12"
          deletePermanently={!!preview}
        />
      )}
    </div>
  );
}

/** The list's menu actions this member may use; a missing one hides its menu item. */
function useSheetActions() {
  const { rename, remove } = useSheetMutations();
  const canUpdate = useCan('sheets:update');
  const canDelete = useCan('sheets:delete');
  return {
    onRename: canUpdate ? (sheet: SheetMeta, name: string) => rename.mutate({ id: sheet.id, name }) : undefined,
    onDelete: canDelete ? (sheet: SheetMeta) => remove.mutate(sheet.id) : undefined,
  };
}

/** Opens a spreadsheet in WeldSheets, or in the preview. */
function useOpenSheet() {
  const navigate = useNavigate();
  const preview = usePreviewMode();
  return useCallback(
    (sheet: SheetMeta) => {
      if (preview) void navigate({ to: '/preview/weldsheets/$sheetId', params: { sheetId: sheet.id } });
      else void navigate({ to: '/weldsheets/$sheetId', params: { sheetId: sheet.id } });
    },
    [navigate, preview],
  );
}

/** Imports a picked file as a new spreadsheet and opens it. */
function useSheetImport(open: (sheet: SheetMeta) => void) {
  const { t, format, language } = useI18n();
  const tf = t.weldsheets.files;
  const { importFile } = useSheetMutations();

  return async (file: File | undefined) => {
    if (!file) return;
    if (file.size > SHEET_IMPORT_MAX_BYTES) {
      toast.error(format(tf.failed, { name: file.name }), { description: tf.tooLarge });
      return;
    }
    const pending = toast.loading(format(tf.importing, { name: file.name }));
    try {
      const { meta, warnings } = await importFile.mutateAsync({ file, locale: fileLocale(language) });
      toast.dismiss(pending);
      announceImport(meta.name, warnings, tf, format);
      open(meta);
    } catch (err) {
      toast.dismiss(pending);
      announceImportFailure(err, file.name, tf, format);
    }
  };
}

/** A grid of cells with a header row, for the empty list. */
function SheetsIllustration() {
  return (
    <EmptyStateIllustration>
      <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="14" y="20" width="92" height="80" rx="6" className="fill-white dark:fill-white/[0.03]" />
        <rect x="14" y="20" width="92" height="80" rx="6" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        <line x1="14" y1="38" x2="106" y2="38" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" opacity="0.7" />
        <line x1="14" y1="58" x2="106" y2="58" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1" opacity="0.5" />
        <line x1="14" y1="78" x2="106" y2="78" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1" opacity="0.5" />
        <line x1="40" y1="20" x2="40" y2="100" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" opacity="0.6" />
        <line x1="73" y1="20" x2="73" y2="100" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1" opacity="0.4" />
      </svg>
    </EmptyStateIllustration>
  );
}
