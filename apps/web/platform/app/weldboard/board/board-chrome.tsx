import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { usePreviewMode } from '@/contexts/preview-mode-context';
import { useI18n } from '@/lib/i18n/provider';

export function MissingBoard({ message, backTo }: { message: string; backTo?: string }) {
  const { t } = useI18n();
  const preview = usePreviewMode();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
      <p>{message}</p>
      <Link to={backTo ?? (preview ? '/preview/weldboard' : '/weldboard')} className="text-sm text-primary underline">
        {t.weldboard.home.backHome}
      </Link>
    </div>
  );
}

/** The back arrow in the board's header. */
export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} aria-label={label} title={label} className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
      <ArrowLeft className="size-4" />
    </Link>
  );
}
