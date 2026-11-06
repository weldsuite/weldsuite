import { Link } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
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

/** The back chevron in the board's header, as in the other editors (WeldSign). */
export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Button variant="ghost" size="icon" className="size-[30px] shrink-0 text-muted-foreground" asChild>
      <Link to={to} aria-label={label} title={label}>
        <ChevronLeft className="!size-[18px]" />
      </Link>
    </Button>
  );
}
