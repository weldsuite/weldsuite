import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { Link } from '@tanstack/react-router';
import { AlertCircle, ArrowLeft, Check, CloudOff, Eye, Loader2, MessageSquare } from 'lucide-react';
import { usePreviewMode } from '@/contexts/preview-mode-context';
import type { SheetController, SidePanel } from '../editor/model/sheet-controller';
import { useI18n } from '@/lib/i18n/provider';

/** What the header says about the sheet's changes. */
export type SheetStatus = 'saved' | 'saving' | 'failed' | 'reconnecting' | 'offline-pending' | 'view-only' | 'comment-only';

/** The bar above the editor: the sheet's name (renamed in place), its status, and whatever else goes on the right. */
export function SheetHeader({
  name,
  canRename,
  onRename,
  status,
  children,
  onBack,
}: {
  name: string;
  canRename: boolean;
  /** Called with the new name when it changed. */
  onRename: (name: string) => void;
  status: SheetStatus;
  children?: ReactNode;
  /** Shown as a back button (a sheet opened inside another page, such as a WeldFlow project). */
  onBack?: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);

  const commit = (next: string) => {
    const trimmed = next.trim() || t.weldsheets.home.untitled;
    setDraft(trimmed);
    if (canRename && trimmed !== name) onRename(trimmed);
  };

  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-b px-3">
      {onBack && (
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onBack} aria-label={t.weldsheets.home.backHome}>
          <ArrowLeft className="size-4" />
        </Button>
      )}
      <input
        value={draft}
        readOnly={!canRename}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        aria-label={t.weldsheets.home.rename}
        className="min-w-0 max-w-md flex-1 rounded px-1 text-base font-medium outline-none hover:bg-muted focus:bg-muted"
      />
      <StatusLabel status={status} />
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </div>
  );
}

function StatusLabel({ status }: { status: SheetStatus }) {
  const { t } = useI18n();
  const te = t.weldsheets.editor;
  const label = {
    saved: te.saved,
    saving: te.saving,
    failed: te.notSaved,
    reconnecting: te.reconnecting,
    'offline-pending': te.offlinePending,
    'view-only': te.viewOnly,
    'comment-only': te.commentOnly,
  }[status];
  const warn = status === 'failed' || status === 'offline-pending';
  let icon = <Check className="size-3.5" />;
  if (status === 'saving' || status === 'reconnecting') icon = <Loader2 className="size-3.5 animate-spin" />;
  else if (status === 'failed') icon = <AlertCircle className="size-3.5" />;
  else if (status === 'offline-pending') icon = <CloudOff className="size-3.5" />;
  else if (status === 'view-only') icon = <Eye className="size-3.5" />;
  else if (status === 'comment-only') icon = <MessageSquare className="size-3.5" />;
  return (
    <span className={`flex min-w-0 items-center gap-1 truncate text-xs ${warn ? 'text-destructive' : 'text-muted-foreground'}`} aria-live="polite">
      {icon}
      {label}
    </span>
  );
}

/** A small icon button in the header that opens and closes a side panel, and shows whether it is open. */
export function PanelToggle({
  controller,
  panel,
  label,
  children,
}: {
  controller: SheetController;
  panel: Exclude<SidePanel, null>;
  label: string;
  children: ReactNode;
}) {
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  const active = controller.panel === panel;
  const onClick = () => {
    if (active) controller.openPanel(null);
    else if (panel === 'comments') controller.openThread(null);
    else controller.openPanel(panel);
  };
  return (
    <TooltipProvider delayDuration={400}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="sm" className={`h-7 w-7 p-0 ${active ? 'bg-accent' : ''}`} onClick={onClick} aria-label={label} aria-pressed={active}>
            {children}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Shown instead of the editor when the sheet cannot be opened. */
export function MissingSheet({ message }: { message: string }) {
  const { t } = useI18n();
  const preview = usePreviewMode();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
      <p>{message}</p>
      <Link to={preview ? '/preview/weldsheets' : '/weldsheets'} className="text-sm text-primary underline">
        {t.weldsheets.home.backHome}
      </Link>
    </div>
  );
}
