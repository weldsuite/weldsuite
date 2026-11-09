import { useEffect, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { AlertCircle, ChevronLeft, CloudOff, Eye, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { usePreviewMode } from '@/contexts/preview-mode-context';
import { useI18n } from '@/lib/i18n/provider';

/** What the header says about the document's changes. */
export type DocStatus = 'saved' | 'saving' | 'failed' | 'reconnecting' | 'offline-pending' | 'view-only';

/** The bar above the editor: the document's name (renamed in place), its status, and whatever else goes on the right. */
export function DocHeader({
  name,
  canRename,
  onRename,
  status,
  children,
}: {
  name: string;
  canRename: boolean;
  onRename: (name: string) => void;
  status: DocStatus;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const preview = usePreviewMode();
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);

  const commit = (next: string) => {
    const trimmed = next.trim() || t.welddocs.home.untitled;
    setDraft(trimmed);
    if (canRename && trimmed !== name) onRename(trimmed);
  };

  // The editors' header row (WeldBoard, WeldSign): back chevron and name on the left, actions on the right.
  return (
    <div className="flex h-[53px] shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-3 md:px-4">
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <Button variant="ghost" size="icon" className="size-[30px] shrink-0 text-muted-foreground" asChild>
          <Link to={preview ? '/preview/welddocs' : '/welddocs'} aria-label={t.welddocs.home.backHome} title={t.welddocs.home.backHome}>
            <ChevronLeft className="!size-[18px]" />
          </Link>
        </Button>
        <input
          value={draft}
          readOnly={!canRename}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          aria-label={t.welddocs.home.rename}
          className="h-7 min-w-0 max-w-md flex-1 rounded px-1 text-[15px] font-medium leading-6 text-foreground outline-none hover:bg-muted focus:bg-muted"
        />
        <StatusLabel status={status} />
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function StatusLabel({ status }: { status: DocStatus }) {
  const { t } = useI18n();
  const te = t.welddocs.editor;
  // Saved and saving are routine and not shown, as in the other editors; only what needs attention is.
  if (status === 'saved' || status === 'saving') return null;
  const label = {
    failed: te.notSaved,
    reconnecting: te.reconnecting,
    'offline-pending': te.offlinePending,
    'view-only': te.viewOnly,
  }[status];
  const warn = status === 'failed' || status === 'offline-pending';
  let icon = <Eye className="size-3.5" />;
  if (status === 'reconnecting') icon = <Loader2 className="size-3.5 animate-spin" />;
  else if (status === 'failed') icon = <AlertCircle className="size-3.5" />;
  else if (status === 'offline-pending') icon = <CloudOff className="size-3.5" />;
  return (
    <span className={`ml-2 flex min-w-0 items-center gap-1 truncate text-xs ${warn ? 'text-destructive' : 'text-muted-foreground'}`} aria-live="polite">
      {icon}
      {label}
    </span>
  );
}

/** Shown instead of the editor when the document cannot be opened. */
export function MissingDoc({ message }: { message: string }) {
  const { t } = useI18n();
  const preview = usePreviewMode();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
      <p>{message}</p>
      <Link to={preview ? '/preview/welddocs' : '/welddocs'} className="text-sm text-primary underline">
        {t.welddocs.home.backHome}
      </Link>
    </div>
  );
}
