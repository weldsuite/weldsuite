import { toast } from 'sonner';
import { Download } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { useI18n } from '@/lib/i18n/provider';
import type { SheetController } from '../editor/model/sheet-controller';
import { downloadCsv, downloadXlsx } from '../files';

/** Downloads the open spreadsheet, written here from the editor's workbook (so unsaved edits are in it). */
export function DownloadMenu({ controller, name }: { controller: SheetController; name: string }) {
  const { t } = useI18n();
  const tf = t.weldsheets.files;
  const locale = controller.options.locale;
  const failed = () => toast.error(tf.downloadFailed);

  const csv = () => {
    try {
      downloadCsv(controller.engine, controller.activeSheetId, name, locale);
    } catch {
      failed();
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2" aria-label={tf.download}>
          <Download className="size-4" />
          <span className="hidden sm:inline">{tf.download}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void downloadXlsx(controller.engine, name, locale).catch(failed)}>{tf.xlsx}</DropdownMenuItem>
        <DropdownMenuItem onSelect={csv}>{tf.csv}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
