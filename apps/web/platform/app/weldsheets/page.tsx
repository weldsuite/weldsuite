import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { usePreviewMode } from '@/contexts/preview-mode-context';
import { FileSpreadsheet, MoreHorizontal, Plus } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { useSheetList, useSheetMutations, type SheetMeta } from './store/use-sheet-store';

export default function WeldSheetsHome() {
  const { t, format, language } = useI18n();
  const th = t.weldsheets.home;
  const navigate = useNavigate();
  const preview = usePreviewMode();
  const { data: sheets, isLoading } = useSheetList();
  const { create, rename, remove } = useSheetMutations();
  const [deleting, setDeleting] = useState<SheetMeta | null>(null);

  const createSheet = async () => {
    const meta = await create.mutateAsync(th.untitled);
    open(meta.id);
  };

  const open = (sheetId: string) => {
    if (preview) navigate({ to: '/preview/weldsheets/$sheetId', params: { sheetId } }).catch(() => undefined);
    else navigate({ to: '/weldsheets/$sheetId', params: { sheetId } }).catch(() => undefined);
  };

  const promptRename = (sheet: SheetMeta) => {
    const name = window.prompt(th.rename, sheet.name)?.trim();
    if (name && name !== sheet.name) rename.mutate({ id: sheet.id, name });
  };

  const edited = (ms: number) =>
    format(th.edited, {
      time: new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms)),
    });

  if (isLoading) return <PageLoader fullScreen={false} />;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-6">
      <section>
        <button
          type="button"
          onClick={() => void createSheet()}
          disabled={create.isPending}
          className="group flex w-40 flex-col items-stretch gap-2 text-left"
        >
          <span className="flex h-28 items-center justify-center rounded-lg border bg-card transition group-hover:border-primary">
            <Plus className="size-8 text-primary" />
          </span>
          <span className="text-sm font-medium">{th.blank}</span>
        </button>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground">{th.recent}</h2>
          <Button size="sm" onClick={() => void createSheet()} disabled={create.isPending}>
            <Plus />
            {th.newSheet}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{th.localNotice}</p>

        {!sheets?.length ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
            <FileSpreadsheet className="size-8 text-muted-foreground" />
            <p className="font-medium">{th.emptyTitle}</p>
            <p className="max-w-sm text-sm text-muted-foreground">{th.emptyDescription}</p>
          </div>
        ) : (
          <ul className="divide-y rounded-lg border">
            {sheets.map((sheet) => (
              <li key={sheet.id} className="flex items-center gap-3 px-4 py-2 hover:bg-muted/50">
                <FileSpreadsheet className="size-5 shrink-0 text-green-600" />
                <button type="button" className="min-w-0 flex-1 truncate text-left text-sm font-medium" onClick={() => open(sheet.id)}>
                  {sheet.name}
                </button>
                <span className="shrink-0 text-xs text-muted-foreground">{edited(sheet.updatedAt)}</span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="size-8" aria-label={sheet.name}>
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => open(sheet.id)}>{th.open}</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => promptRename(sheet)}>{th.rename}</DropdownMenuItem>
                    <DropdownMenuItem className="text-destructive" onSelect={() => setDeleting(sheet)}>
                      {th.delete}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={th.deleteTitle}
        description={format(th.deleteDescription, { name: deleting?.name ?? '' })}
        confirmLabel={th.delete}
        variant="destructive"
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
          setDeleting(null);
        }}
      />
    </div>
  );
}
