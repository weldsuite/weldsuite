/**
 * The Keys section of a storefront channel: the publishable and private keys
 * the shop uses to call the storefront API. A key shows its prefix, never
 * its secret; a new or rotated key's secret is shown once, in `SecretDialog`.
 * Reading needs `commerce_channels:read`, everything else `:update`.
 */

import { useState } from 'react';
import { KeyRound, Pencil, Plus, RefreshCw, Ban } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SettingsSection } from '@weldsuite/ui/components/settings-layout';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import {
  useChannelKeys,
  useRevokeChannelKey,
  useRotateChannelKey,
  type ChannelKey,
  type ChannelKeySecret,
} from '@/hooks/queries/use-commerce-channels-queries';
import { formatPanelDate } from '@/components/objects/_shared/simple-object-panel';
import { getTranslations } from '@/lib/i18n';
import { keyKindLabel } from '@/app/weldcommerce/lib/channels';
import { errorMessage, fill } from '@/app/weldcommerce/lib/text';
import { KeyDialog } from './key-dialog';
import { SecretDialog } from './secret-dialog';

type KeyAction = { kind: 'rotate' | 'revoke'; key: ChannelKey };

function KeyRow({
  channelKey,
  canUpdate,
  onEdit,
  onAction,
}: Readonly<{
  channelKey: ChannelKey;
  canUpdate: boolean;
  onEdit: () => void;
  onAction: (kind: KeyAction['kind']) => void;
}>) {
  const t = getTranslations('commerce').channels.keys;
  const revoked = channelKey.revokedAt !== null;
  return (
    <TableRow className={revoked ? 'text-muted-foreground' : undefined}>
      <TableCell className="max-w-[14rem]">
        <span className="block truncate font-medium">{channelKey.name}</span>
        <SoftBadge tone="neutral" className="mt-1">
          {keyKindLabel(channelKey.kind)}
        </SoftBadge>
      </TableCell>
      <TableCell>
        <code className="whitespace-nowrap font-mono text-xs">{channelKey.keyPrefix}…</code>
      </TableCell>
      <TableCell className="hidden max-w-[16rem] @2xl:table-cell">
        {channelKey.kind === 'publishable' && channelKey.allowedOrigins.length > 0 ? (
          <ul className="space-y-0.5 font-mono text-xs">
            {channelKey.allowedOrigins.map((origin) => (
              <li key={origin} className="truncate" title={origin}>
                {origin}
              </li>
            ))}
          </ul>
        ) : (
          <span aria-label={t.noOrigins}>—</span>
        )}
      </TableCell>
      <TableCell className="hidden whitespace-nowrap tabular-nums @3xl:table-cell">
        {formatPanelDate(channelKey.createdAt) ?? '—'}
      </TableCell>
      <TableCell className="hidden whitespace-nowrap tabular-nums @3xl:table-cell">
        {formatPanelDate(channelKey.lastUsedAt) ?? t.neverUsed}
      </TableCell>
      <TableCell>
        {revoked ? (
          <SoftBadge tone="danger">{fill(t.revokedOn, { date: formatPanelDate(channelKey.revokedAt) ?? '' })}</SoftBadge>
        ) : (
          <SoftBadge tone="success">{t.active}</SoftBadge>
        )}
      </TableCell>
      <TableCell className="text-right">
        {canUpdate && !revoked && (
          <div className="flex justify-end gap-1">
            <Button type="button" variant="ghost" size="icon" aria-label={fill(t.editLabel, { name: channelKey.name })} onClick={onEdit}>
              <Pencil className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button type="button" variant="ghost" size="icon" aria-label={fill(t.rotateLabel, { name: channelKey.name })} onClick={() => onAction('rotate')}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button type="button" variant="ghost" size="icon" aria-label={fill(t.revokeLabel, { name: channelKey.name })} onClick={() => onAction('revoke')}>
              <Ban className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

export function ChannelKeysSection({
  channelId,
  canUpdate,
}: Readonly<{ channelId: string; canUpdate: boolean }>) {
  const t = getTranslations('commerce');
  const tk = t.channels.keys;
  const tc = getTranslations('common');
  const keys = useChannelKeys(channelId);
  const rotate = useRotateChannelKey();
  const revoke = useRevokeChannelKey();
  const [dialog, setDialog] = useState<{ key?: ChannelKey } | null>(null);
  const [action, setAction] = useState<KeyAction | null>(null);
  const [secret, setSecret] = useState<{ value: ChannelKeySecret; rotated: boolean } | null>(null);

  const confirmAction = async () => {
    if (!action) return;
    try {
      if (action.kind === 'rotate') {
        const res = await rotate.mutateAsync({ channelId, keyId: action.key.id });
        setSecret({ value: res.data, rotated: true });
      } else {
        await revoke.mutateAsync({ channelId, keyId: action.key.id });
        toast.success(tk.toastRevoked);
      }
    } catch (err) {
      toast.error(errorMessage(err, t.common.saveFailed));
    } finally {
      setAction(null);
    }
  };

  const addButton = canUpdate ? (
    <Button type="button" size="sm" onClick={() => setDialog({})}>
      <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
      {tk.add}
    </Button>
  ) : undefined;

  const rows = keys.data?.data ?? [];
  let body;
  if (keys.isPending) body = <PageLoader fullScreen={false} />;
  else if (keys.isError) body = <ErrorState message={tk.loadFailed} onRetry={() => void keys.refetch()} />;
  else if (rows.length === 0) body = <EmptyState icon={KeyRound} title={tk.empty} description={tk.emptyDescription} action={addButton} />;
  else {
    body = (
      <div className="@container rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tk.columns.name}</TableHead>
              <TableHead>{tk.columns.key}</TableHead>
              <TableHead className="hidden @2xl:table-cell">{tk.columns.origins}</TableHead>
              <TableHead className="hidden @3xl:table-cell">{tk.columns.created}</TableHead>
              <TableHead className="hidden @3xl:table-cell">{tk.columns.lastUsed}</TableHead>
              <TableHead>{tk.columns.status}</TableHead>
              <TableHead>
                <span className="sr-only">{tk.columns.actions}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((channelKey) => (
              <KeyRow
                key={channelKey.id}
                channelKey={channelKey}
                canUpdate={canUpdate}
                onEdit={() => setDialog({ key: channelKey })}
                onAction={(kind) => setAction({ kind, key: channelKey })}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  const rotating = action?.kind === 'rotate';
  const confirmTemplate = rotating ? tk.rotateDescription : tk.revokeDescription;
  const confirmText = action ? fill(confirmTemplate, { name: action.key.name }) : '';

  return (
    <SettingsSection title={tk.title} description={tk.description}>
      {rows.length > 0 && addButton && <div className="flex justify-end">{addButton}</div>}
      {body}

      {dialog && (
        <KeyDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          channelId={channelId}
          keyToEdit={dialog.key}
          onCreated={(value) => setSecret({ value, rotated: false })}
        />
      )}

      <ConfirmDialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open) setAction(null);
        }}
        title={rotating ? tk.rotateTitle : tk.revokeTitle}
        description={confirmText}
        variant="destructive"
        confirmLabel={rotating ? tk.rotate : tk.revoke}
        cancelLabel={tc.actions.cancel}
        onConfirm={confirmAction}
      />

      <SecretDialog secret={secret?.value ?? null} rotated={secret?.rotated} onClose={() => setSecret(null)} />
    </SettingsSection>
  );
}
