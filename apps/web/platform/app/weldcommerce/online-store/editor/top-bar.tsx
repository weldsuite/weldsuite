/**
 * The editor's top bar: back to the online store, the template or content
 * page being edited, the preview width, undo and redo, whether the changes
 * are saved, the version history and Publish.
 */

import { useAtom } from 'jotai';
import { ArrowLeft, History, Monitor, Redo2, RotateCw, Smartphone, Tablet, Undo2 } from 'lucide-react';
import { TEMPLATE_NAMES } from '@weldsuite/storefront-theme/catalog';
import { Button } from '@weldsuite/ui/components/button';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import type { StorePage } from '@/hooks/queries/use-online-store-queries';
import { Link } from '@/lib/router';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { deviceAtom, useEditorHistory, useEditorDispatch, type DeviceWidth, type EditorView } from './editor-state';
import type { SaveStatus } from './use-autosave';

export function viewValue(view: EditorView): string {
  return view.kind === 'page' ? `page:${view.pageId}` : `template:${view.template}`;
}

const DEVICE_ICONS = { phone: Smartphone, tablet: Tablet, desktop: Monitor } as const;

function SaveState({ status, onRetry }: Readonly<{ status: SaveStatus; onRetry: () => void }>) {
  const t = getTranslations('commerce').onlineStore.editor;
  const failed = status === 'error';
  return (
    <div className="flex items-center gap-1">
      <p role="status" className={cn('text-xs whitespace-nowrap', failed || status === 'invalid' || status === 'conflict' ? 'text-destructive' : 'text-muted-foreground')}>
        {t.status[status]}
      </p>
      {failed && (
        <Button type="button" variant="link" size="sm" className="h-auto px-1 text-xs" onClick={onRetry}>
          {t.retry}
        </Button>
      )}
    </div>
  );
}

export function EditorTopBar({
  storeName,
  view,
  pages,
  onViewChange,
  status,
  onRetry,
  onReloadPreview,
  previewAvailable,
  readOnly,
  canPublish,
  onPublish,
  onOpenHistory,
}: Readonly<{
  storeName: string;
  view: EditorView;
  pages: StorePage[];
  onViewChange: (view: EditorView) => void;
  status: SaveStatus;
  onRetry: () => void;
  onReloadPreview: () => void;
  previewAvailable: boolean;
  readOnly: boolean;
  canPublish: boolean;
  onPublish: () => void;
  onOpenHistory: () => void;
}>) {
  const t = getTranslations('commerce').onlineStore.editor;
  const history = useEditorHistory();
  const dispatch = useEditorDispatch();
  const [device, setDevice] = useAtom(deviceAtom);

  const onSelectView = (value: string) => {
    const [kind, id] = value.split(':', 2) as [string, string];
    if (kind === 'page') onViewChange({ kind: 'page', pageId: id });
    else if ((TEMPLATE_NAMES as readonly string[]).includes(id)) onViewChange({ kind: 'template', template: id as (typeof TEMPLATE_NAMES)[number] });
  };

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
      <Button asChild variant="ghost" size="icon" className="size-8 shrink-0">
        <Link href="/weldcommerce/online-store" aria-label={t.back} title={t.back}>
          <ArrowLeft className="size-4" aria-hidden="true" />
        </Link>
      </Button>
      <h1 className="hidden max-w-[12rem] truncate text-sm font-semibold lg:block">{storeName}</h1>
      <Select value={viewValue(view)} onValueChange={onSelectView}>
        <SelectTrigger className="h-8 w-48 shrink-0" aria-label={t.view}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>{t.templatesGroup}</SelectLabel>
            {TEMPLATE_NAMES.map((template) => (
              <SelectItem key={template} value={`template:${template}`}>
                {t.templates[template]}
              </SelectItem>
            ))}
          </SelectGroup>
          {pages.length > 0 && (
            <SelectGroup>
              <SelectLabel>{t.pagesGroup}</SelectLabel>
              {pages.map((page) => (
                <SelectItem key={page.id} value={`page:${page.id}`}>
                  {page.title}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>

      <div className="mx-auto flex items-center gap-1">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={device}
          onValueChange={(value) => {
            if (value) setDevice(value as DeviceWidth);
          }}
          aria-label={t.device}
        >
          {(['phone', 'tablet', 'desktop'] as const).map((width) => {
            const Icon = DEVICE_ICONS[width];
            return (
              <ToggleGroupItem key={width} value={width} aria-label={t.devices[width]} title={t.devices[width]}>
                <Icon className="size-4" aria-hidden="true" />
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
        <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={t.previewReload} title={t.previewReload} disabled={!previewAvailable} onClick={onReloadPreview}>
          <RotateCw className="size-4" aria-hidden="true" />
        </Button>
      </div>

      {!readOnly && (
        <div className="flex items-center">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={t.undo}
            title={`${t.undo} (${t.undoShortcut})`}
            aria-keyshortcuts="Control+Z Meta+Z"
            disabled={history.past.length === 0}
            onClick={() => dispatch({ type: 'undo' })}
          >
            <Undo2 className="size-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={t.redo}
            title={`${t.redo} (${t.redoShortcut})`}
            aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y"
            disabled={history.future.length === 0}
            onClick={() => dispatch({ type: 'redo' })}
          >
            <Redo2 className="size-4" aria-hidden="true" />
          </Button>
        </div>
      )}
      {!readOnly && <SaveState status={status} onRetry={onRetry} />}
      <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={t.history} title={t.history} onClick={onOpenHistory}>
        <History className="size-4" aria-hidden="true" />
      </Button>
      {canPublish && (
        <Button type="button" size="sm" onClick={onPublish}>
          {t.publish}
        </Button>
      )}
    </header>
  );
}
