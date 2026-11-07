import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Laptop, Loader2, Plus, X } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { Link } from '@/lib/router';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import type { DeskConversation } from '@/hooks/queries/use-desk-queries';
import {
  useAttachRelated,
  useCustomObjectBySlug,
  useCustomObjectLinks,
  useCustomObjectRecords,
  useDetachRelated,
  useReverseRelatedPanels,
} from '@/hooks/queries/use-custom-objects-queries';

/** The object the asset register template installs. */
const ASSET_SLUG = 'asset';

/**
 * The inbox details panel's "Assets": the assets linked to this
 * conversation, with an "Attach asset" search and detach. Shown only when
 * the workspace has the asset register (Settings → Apps → WeldDesk) and the
 * agent may read assets; attaching and detaching need
 * `weldobjects:asset:update`.
 */
export function ConversationAssets({ conversation }: Readonly<{ conversation: DeskConversation }>) {
  const t = getTranslations('helpdesk').assets;
  const { can } = usePermissions();
  const canRead = can(`weldobjects:${ASSET_SLUG}:read`);
  const canEdit = can(`weldobjects:${ASSET_SLUG}:update`);
  const { data: object } = useCustomObjectBySlug(canRead ? ASSET_SLUG : undefined);
  const active = !!object && object.status !== 'disabled';
  const { data: links } = useCustomObjectLinks(active ? object.id : undefined);
  // The relationship to inbox conversations (the template's `tickets`).
  const link = links?.find((l) => l.targetEntityKey === 'conversation');
  const { data: panels, isLoading } = useReverseRelatedPanels(
    link ? 'conversation' : undefined,
    link ? conversation.id : undefined,
  );
  const attach = useAttachRelated(ASSET_SLUG);
  const detach = useDetachRelated(ASSET_SLUG);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const { data: found, isFetching: searching } = useCustomObjectRecords(open && link ? ASSET_SLUG : undefined, {
    search: search.trim() || undefined,
    limit: 20,
  });

  const attached = useMemo(
    () =>
      (panels ?? [])
        .filter((panel) => panel.objectSlug === ASSET_SLUG && panel.linkSlug === link?.slug)
        .flatMap((panel) => panel.records),
    [panels, link?.slug],
  );
  const attachedIds = new Set(attached.map((asset) => asset.id));
  const candidates = (found?.data ?? []).filter((record) => !attachedIds.has(record.id));

  if (!canRead || !active || !link) return null;

  const onAttach = async (assetId: string) => {
    setOpen(false);
    setSearch('');
    try {
      await attach.mutateAsync({ recordId: assetId, linkSlug: link.slug, targetId: conversation.id });
      toast.success(t.attached);
    } catch {
      toast.error(t.attachFailed);
    }
  };

  const onDetach = async (assetId: string) => {
    try {
      await detach.mutateAsync({ recordId: assetId, linkSlug: link.slug, targetId: conversation.id });
      toast.success(t.detached);
    } catch {
      toast.error(t.detachFailed);
    }
  };

  return (
    <div className="px-4 py-3 border-b border-border/60" data-testid="desk-inbox-assets">
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.panelTitle}</p>
        {canEdit && (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-xs text-muted-foreground"
                data-testid="desk-inbox-assets-attach"
              >
                <Plus className="h-3.5 w-3.5 mr-0.5" />
                {t.attach}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 p-0">
              <Command shouldFilter={false}>
                <CommandInput placeholder={t.searchPlaceholder} value={search} onValueChange={setSearch} />
                <CommandList className="max-h-60">
                  {searching && candidates.length === 0 ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    <CommandEmpty>{t.noResults}</CommandEmpty>
                  )}
                  {candidates.map((record) => (
                    <CommandItem key={record.id} value={record.id} onSelect={() => void onAttach(record.id)}>
                      <Laptop className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="truncate">{record.title || t.untitled}</span>
                    </CommandItem>
                  ))}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        )}
      </div>
      {isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      {!isLoading && attached.length === 0 && <p className="text-sm text-muted-foreground">{t.none}</p>}
      <ul className="space-y-0.5">
        {attached.map((asset) => (
          <li key={asset.relationId} className="group flex items-center gap-2 text-sm" data-testid="desk-inbox-asset">
            <Laptop className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            <Link href={asset.href} className="min-w-0 flex-1 truncate hover:underline">
              {asset.title || t.untitled}
            </Link>
            {canEdit && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6 flex-shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => void onDetach(asset.id)}
                disabled={detach.isPending}
                aria-label={t.detach.replace('{name}', asset.title || t.untitled)}
                title={t.detach.replace('{name}', asset.title || t.untitled)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
