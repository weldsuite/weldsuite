/**
 * The Channels tab of Settings → Apps → WeldCommerce: the workspace's sales
 * channels with create, edit and archive; a channel opens into its keys and
 * shipping rates (`ChannelDetail`). The open channel is in the URL
 * (`?tab=channels&channel=<id>`), so it can be shared and survives a reload.
 */

import { useState } from 'react';
import { Archive, Pencil, Plus, Store } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import {
  useCommerceChannels,
  useDeleteCommerceChannel,
  type CommerceChannel,
} from '@/hooks/queries/use-commerce-channels-queries';
import { getLocale, getTranslations } from '@/lib/i18n';
import { plural } from '@/lib/i18n/plural';
import {
  channelAudienceLabel,
  channelStatusLabel,
  channelStatusTone,
  channelTypeLabel,
} from '@/app/weldcommerce/lib/channels';
import { errorMessage, fill } from '@/app/weldcommerce/lib/text';
import { ChannelDialog } from './channel-dialog';
import { ChannelDetail } from './channel-detail';

function ChannelRow({
  channel,
  canUpdate,
  canDelete,
  onOpen,
  onEdit,
  onArchive,
}: Readonly<{
  channel: CommerceChannel;
  canUpdate: boolean;
  canDelete: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onArchive: () => void;
}>) {
  const t = getTranslations('commerce').channels;
  return (
    <TableRow>
      <TableCell className="max-w-[16rem]">
        <button
          type="button"
          onClick={onOpen}
          className="block max-w-full truncate rounded-sm text-left font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {channel.name}
        </button>
      </TableCell>
      <TableCell className="hidden @xl:table-cell">{channelTypeLabel(channel.type)}</TableCell>
      <TableCell className="hidden @2xl:table-cell">{channelAudienceLabel(channel.audience)}</TableCell>
      <TableCell>
        <SoftBadge tone={channelStatusTone(channel.status)}>{channelStatusLabel(channel.status)}</SoftBadge>
      </TableCell>
      <TableCell className="hidden @xl:table-cell">{channel.currency}</TableCell>
      <TableCell className="hidden whitespace-nowrap tabular-nums @3xl:table-cell">
        {plural(channel.sellingCountries.length, t.countriesCount, getLocale())}
      </TableCell>
      <TableCell className="hidden tabular-nums @3xl:table-cell">{channel.activeKeyCount}</TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          {canUpdate && (
            <Button type="button" variant="ghost" size="icon" aria-label={fill(t.editLabel, { name: channel.name })} onClick={onEdit}>
              <Pencil className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
          {canDelete && channel.status !== 'archived' && (
            <Button type="button" variant="ghost" size="icon" aria-label={fill(t.archiveLabel, { name: channel.name })} onClick={onArchive}>
              <Archive className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

export function ChannelsTab({
  channelId,
  onOpenChannel,
}: Readonly<{ channelId?: string; onOpenChannel: (id: string | undefined) => void }>) {
  const t = getTranslations('commerce');
  const tc = t.channels;
  const common = getTranslations('common');
  const permissions = usePermissionsMaybe();
  const canRead = permissions?.can('commerce_channels:read') ?? false;
  const canCreate = permissions?.can('commerce_channels:create') ?? false;
  const canUpdate = permissions?.can('commerce_channels:update') ?? false;
  const canDelete = permissions?.can('commerce_channels:delete') ?? false;
  const channels = useCommerceChannels({}, canRead);
  const archive = useDeleteCommerceChannel();
  const [dialog, setDialog] = useState<{ channel?: CommerceChannel } | null>(null);
  const [archiving, setArchiving] = useState<CommerceChannel | null>(null);

  if (!canRead) return <p className="text-sm text-muted-foreground">{tc.noPermission}</p>;
  if (channelId) {
    return (
      <ChannelDetail
        channelId={channelId}
        onBack={() => onOpenChannel(undefined)}
        canCreate={canCreate}
        canUpdate={canUpdate}
        canDelete={canDelete}
      />
    );
  }
  if (channels.isPending) return <PageLoader fullScreen={false} />;
  if (channels.isError) return <ErrorState message={tc.loadFailed} onRetry={() => void channels.refetch()} />;

  const rows = channels.data.data ?? [];
  const newButton = canCreate ? (
    <Button type="button" size="sm" onClick={() => setDialog({})}>
      <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
      {tc.newButton}
    </Button>
  ) : undefined;

  const confirmArchive = async () => {
    if (!archiving) return;
    try {
      await archive.mutateAsync(archiving.id);
      toast.success(tc.toastArchived);
    } catch (err) {
      toast.error(errorMessage(err, t.common.deleteFailed));
    } finally {
      setArchiving(null);
    }
  };

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{tc.title}</h2>
          <p className="text-sm text-muted-foreground">{tc.description}</p>
        </div>
        {rows.length > 0 && newButton}
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={Store} title={tc.empty} description={tc.emptyDescription} action={newButton} />
      ) : (
        <div className="@container rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tc.columns.name}</TableHead>
                <TableHead className="hidden @xl:table-cell">{tc.columns.type}</TableHead>
                <TableHead className="hidden @2xl:table-cell">{tc.columns.audience}</TableHead>
                <TableHead>{tc.columns.status}</TableHead>
                <TableHead className="hidden @xl:table-cell">{tc.columns.currency}</TableHead>
                <TableHead className="hidden @3xl:table-cell">{tc.columns.countries}</TableHead>
                <TableHead className="hidden @3xl:table-cell">{tc.columns.keys}</TableHead>
                <TableHead>
                  <span className="sr-only">{tc.columns.actions}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((channel) => (
                <ChannelRow
                  key={channel.id}
                  channel={channel}
                  canUpdate={canUpdate}
                  canDelete={canDelete}
                  onOpen={() => onOpenChannel(channel.id)}
                  onEdit={() => setDialog({ channel })}
                  onArchive={() => setArchiving(channel)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {dialog && (
        <ChannelDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          channel={dialog.channel}
          onSaved={(id) => {
            if (id) onOpenChannel(id);
          }}
        />
      )}

      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => {
          if (!open) setArchiving(null);
        }}
        title={tc.archiveTitle}
        description={archiving ? fill(tc.archiveDescription, { name: archiving.name }) : ''}
        variant="destructive"
        confirmLabel={tc.archive}
        cancelLabel={common.actions.cancel}
        onConfirm={confirmArchive}
      />
    </div>
  );
}
