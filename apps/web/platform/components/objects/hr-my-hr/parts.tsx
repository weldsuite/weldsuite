/**
 * Pieces the My HR panels share (time off, expenses): the title with its status, the "⋮"
 * menu with "Copy link", and the body of an item that could not be read.
 */

import type { ReactNode } from 'react';
import { EllipsisVertical, LayoutGrid, Link as LinkIcon } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import type { ObjectPanelTabDescriptor } from '@/components/object-panel';
import { RecordLoadFailed, useCopyPanelLink } from '@/components/objects/_shared/record-panel-parts';
import { errorMessage } from '@/app/weldhr/components/shared';
import { ColorDot } from '@/app/weldhr/me/components/shared';

/** Width of the side panel, as the employee panel. */
export const MY_HR_PANEL_WIDTH = 400;

/** The Details tab every My HR panel opens on. */
export function useDetailsTab(): ObjectPanelTabDescriptor {
  const st = useTranslations();
  return { id: 'overview', label: st('sweep.entities.detailsTab'), icon: LayoutGrid };
}

export function MyHrPanelTitle({
  label,
  color,
  status,
}: Readonly<{
  /** Undefined while the item loads. */
  label: string | undefined;
  /** A leave type's colour; leave out for no dot. */
  color?: string | null;
  status?: ReactNode;
}>) {
  if (label === undefined) return <div className="h-4 w-32 animate-pulse rounded bg-muted" />;
  return (
    <div className="flex min-w-0 items-center gap-2">
      {color !== undefined && <ColorDot color={color} />}
      <span className="relative top-px truncate text-[15px] font-medium text-foreground">{label}</span>
      {status && <span className="flex-shrink-0">{status}</span>}
    </div>
  );
}

/** The header's "⋮" menu: "Copy link", then the item's own actions. */
export function MyHrPanelMenu({
  listPath,
  type,
  id,
  children,
}: Readonly<{
  /** The My HR page the panel opens on, for "Copy link". */
  listPath: string;
  type: string;
  id: string;
  children?: ReactNode;
}>) {
  const st = useTranslations();
  const copyLink = useCopyPanelLink(listPath, type, id);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7 data-[state=open]:bg-accent dark:data-[state=open]:bg-accent/50"
          aria-label={st('sweep.entities.moreActions')}
        >
          <EllipsisVertical className="h-4 w-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => void copyLink()}>
          <LinkIcon />
          {st('sweep.entities.copyLink')}
        </DropdownMenuItem>
        {children ? (
          <>
            <DropdownMenuSeparator />
            {children}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The body when the list could not be read, or the item is not in it (any more). */
export function MyHrPanelMissing({
  loaded,
  error,
  onRetry,
}: Readonly<{ loaded: boolean; error: unknown; onRetry: () => void }>) {
  const t = useTranslations();
  if (loaded) {
    return (
      <RecordLoadFailed notFound message={t('weldhr.me.panel.notFound')} retryLabel="" onRetry={onRetry} />
    );
  }
  if (!error) return null;
  return (
    <RecordLoadFailed
      notFound={false}
      message={errorMessage(error, t('weldhr.me.panel.loadFailed'))}
      retryLabel={t('common.actions.retry')}
      onRetry={onRetry}
    />
  );
}
