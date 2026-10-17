/**
 * Building blocks the WeldBooks record panels (payroll run, VAT return, sales
 * tax agency, exemption certificate) share, so each panel file holds only what
 * is particular to its record:
 *
 *   - `useCopyPanelLink`: the "Copy link" action of the panel's menu;
 *   - `PanelRow`: a read-only line of the Details tab;
 *   - `PanelSection`: a titled block of the Details tab;
 *   - `PanelNotice`: a muted one-line note under the properties;
 *   - `PanelAvatar`: the rounded-square avatar next to the title.
 */

import { useCallback, type ComponentType, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { PropertyRow, type PropertyRowProps } from '@/components/objects/_shared/property-row';
import { useWorkspaceUrl } from '@/hooks/use-workspace-url';
import { cn } from '@/lib/utils';

/**
 * Copies the deep link of a record: its list page with the record's panel open
 * (`<listPath>?stack=<type>:<id>`), with a toast for the outcome.
 */
export function useCopyPanelLink(listPath: string, type: string, id: string): () => Promise<void> {
  const st = useTranslations();
  const workspaceUrl = useWorkspaceUrl();
  return useCallback(async () => {
    try {
      await navigator.clipboard.writeText(workspaceUrl(`${listPath}?stack=${type}:${id}`));
      toast.success(st('sweep.entities.linkCopied'));
    } catch {
      toast.error(st('sweep.entities.copyLinkFailed'));
    }
  }, [st, workspaceUrl, listPath, type, id]);
}

/**
 * A read-only line of the Details tab. An empty value shows a dash: the
 * default placeholder of `PropertyRow` ("Set …") invites an edit these rows
 * do not offer.
 */
export function PanelRow(props: Readonly<Omit<PropertyRowProps, 'readOnly' | 'placeholder'>>) {
  return <PropertyRow {...props} readOnly placeholder="—" />;
}

/** A titled block of the Details tab. */
export function PanelSection({
  title,
  children,
  className,
}: Readonly<{ title: string; children: ReactNode; className?: string }>) {
  return (
    <section className={cn('space-y-2', className)}>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** A muted note under the properties (a reversed payroll, an unregistered agency). */
export function PanelNotice({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <p className="rounded-lg bg-muted/50 px-3 py-2 text-sm text-muted-foreground" role="status">
      {children}
    </p>
  );
}

/** The rounded-square avatar every record panel shows next to its title. */
export function PanelAvatar({
  icon: Icon,
  className,
}: Readonly<{ icon: ComponentType<{ className?: string }>; className: string }>) {
  return (
    <div className={cn('flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg', className)}>
      <Icon className="h-3.5 w-3.5" />
    </div>
  );
}
