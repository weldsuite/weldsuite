/**
 * One password-manager item.
 *
 * Nothing secret is on screen, or even in memory, until the user asks: opening
 * the dialog only shows what the list already carried (title, username, site).
 * Reveal, copying a secret and Edit each make one audited reveal request.
 * Revealed values live in this component's state and go away when it unmounts.
 */

import { useState } from 'react';
import {
  ExternalLink,
  Eye,
  EyeOff,
  FolderInput,
  History,
  Loader2,
  Pencil,
  Trash2,
} from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import type {
  WeldPassItem,
  WeldPassItemFields,
  WeldPassRevealedItem,
} from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  useDeleteWeldPassItem,
  useRevealWeldPassItem,
} from '@/hooks/queries/use-weldpass-passwords-queries';
import { ErrorBanner, TimeAgo, errorMessage } from '../../components/shared';
import { safeHref } from '../lib/items';
import { usePasswordsT } from '../lib/use-passwords-t';
import { CopyButton } from './copy-button';
import { ItemTypeIcon } from './item-type-icon';
import { TotpCode } from './totp-code';

const MASK = '••••••••••••';

/** A field of the revealed document, by name. Every field is a string. */
function readField(fields: WeldPassItemFields, key: string): string {
  return (fields as Record<string, string>)[key] ?? '';
}

function FieldRow({
  label,
  actions,
  children,
}: Readonly<{ label: string; actions?: React.ReactNode; children: React.ReactNode }>) {
  return (
    <div className="flex items-start justify-between gap-3 border-b py-2.5 last:border-0">
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        <div className="mt-0.5 break-words text-sm">{children}</div>
      </div>
      {actions && <div className="flex shrink-0 items-center">{actions}</div>}
    </div>
  );
}

export function ItemDetailDialog({
  item,
  vaultName,
  canEdit,
  onClose,
  onEdit,
  onMove,
  onHistory,
}: Readonly<{
  item: WeldPassItem;
  vaultName: string;
  canEdit: boolean;
  onClose: () => void;
  /** Receives the decrypted item to prefill the form with. */
  onEdit: (revealed: WeldPassRevealedItem) => void;
  onMove: (item: WeldPassItem) => void;
  onHistory: (item: WeldPassItem) => void;
}>) {
  const tp = usePasswordsT();
  const reveal = useRevealWeldPassItem();
  const deleteItem = useDeleteWeldPassItem();

  const [revealed, setRevealed] = useState<WeldPassRevealedItem | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const fields = revealed?.fields ?? null;
  const href = safeHref(item.url);

  function fetchRevealed() {
    return reveal.mutateAsync({ vaultId: item.vaultId, itemId: item.id });
  }

  async function toggleReveal() {
    if (revealed) {
      setRevealed(null);
      return;
    }
    setFailure(null);
    try {
      setRevealed(await fetchRevealed());
    } catch (err) {
      setFailure(errorMessage(err, tp('detail.revealFailed')));
    }
  }

  /**
   * The value to copy. When the item is already revealed it is read from
   * there; otherwise it is fetched, copied and dropped, so the field on screen
   * stays masked.
   */
  function copyField(key: string) {
    return async () => {
      const source = fields ?? (await fetchRevealed()).fields;
      return readField(source, key);
    };
  }

  async function startEdit() {
    setFailure(null);
    try {
      onEdit(revealed ?? (await fetchRevealed()));
    } catch (err) {
      setFailure(errorMessage(err, tp('detail.revealFailed')));
    }
  }

  async function remove() {
    try {
      await deleteItem.mutateAsync({ vaultId: item.vaultId, itemId: item.id });
      onClose();
    } catch (err) {
      setConfirmingDelete(false);
      setFailure(errorMessage(err, tp('detail.deleteFailed')));
    }
  }

  const copyError = (err: unknown) => setFailure(errorMessage(err, tp('detail.revealFailed')));
  const revealButton = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => void toggleReveal()}
      disabled={reveal.isPending}
      aria-label={revealed ? tp('detail.hide') : tp('detail.reveal')}
      title={revealed ? tp('detail.hide') : tp('detail.reveal')}
    >
      {reveal.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
      {!reveal.isPending && (revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />)}
    </Button>
  );

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 pr-6">
              <ItemTypeIcon type={item.type} className="text-muted-foreground" />
              <span className="min-w-0 truncate">{item.title}</span>
            </DialogTitle>
            <DialogDescription className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary">{tp(`types.${item.type}`)}</Badge>
              <span>{vaultName}</span>
            </DialogDescription>
          </DialogHeader>

          <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

          <div>
            {item.type === 'login' && (
              <>
                <FieldRow
                  label={tp('fields.username')}
                  actions={
                    item.subtitle ? (
                      // The username is on the list already; no reveal needed.
                      <CopyButton
                        resolve={() => item.subtitle ?? ''}
                        label={tp('detail.copyUsername')}
                      />
                    ) : undefined
                  }
                >
                  {item.subtitle || <span className="text-muted-foreground">—</span>}
                </FieldRow>

                <FieldRow
                  label={tp('fields.password')}
                  actions={
                    <>
                      {revealButton}
                      <CopyButton
                        resolve={copyField('password')}
                        label={tp('detail.copyPassword')}
                        onError={copyError}
                      />
                    </>
                  }
                >
                  {fields ? (
                    <span className="break-all font-mono text-xs">
                      {readField(fields, 'password') || (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </span>
                  ) : (
                    <span className="font-mono text-xs text-muted-foreground">{MASK}</span>
                  )}
                </FieldRow>

                {href && (
                  <FieldRow
                    label={tp('fields.website')}
                    actions={
                      <Button asChild variant="ghost" size="sm">
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={tp('detail.openWebsite')}
                          title={tp('detail.openWebsite')}
                        >
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      </Button>
                    }
                  >
                    <span className="break-all">{item.url}</span>
                  </FieldRow>
                )}

                {item.hasTotp && (
                  <FieldRow label={tp('fields.totp')}>
                    <TotpCode vaultId={item.vaultId} itemId={item.id} />
                  </FieldRow>
                )}

                {fields && readField(fields, 'notes') && (
                  <FieldRow label={tp('fields.notes')}>
                    <p className="whitespace-pre-wrap">{readField(fields, 'notes')}</p>
                  </FieldRow>
                )}
              </>
            )}

            {item.type === 'note' && (
              <FieldRow label={tp('fields.content')} actions={revealButton}>
                {fields ? (
                  <p className="whitespace-pre-wrap">{readField(fields, 'content')}</p>
                ) : (
                  <span className="font-mono text-xs text-muted-foreground">{MASK}</span>
                )}
              </FieldRow>
            )}

            {item.type === 'card' && (
              <>
                <FieldRow
                  label={tp('fields.number')}
                  actions={
                    <>
                      {revealButton}
                      <CopyButton
                        resolve={copyField('number')}
                        label={tp('detail.copyNumber')}
                        onError={copyError}
                      />
                    </>
                  }
                >
                  <span className="font-mono text-xs">
                    {fields ? readField(fields, 'number') : item.subtitle || MASK}
                  </span>
                </FieldRow>
                <FieldRow label={tp('fields.cardholder')}>
                  {fields ? readField(fields, 'cardholder') || '—' : <MaskedValue />}
                </FieldRow>
                <FieldRow label={tp('fields.expiry')}>
                  {fields ? readField(fields, 'expiry') || '—' : <MaskedValue />}
                </FieldRow>
                <FieldRow
                  label={tp('fields.cvc')}
                  actions={
                    <CopyButton
                      resolve={copyField('cvc')}
                      label={tp('detail.copyCvc')}
                      onError={copyError}
                    />
                  }
                >
                  {fields ? readField(fields, 'cvc') || '—' : <MaskedValue />}
                </FieldRow>
                {fields && readField(fields, 'notes') && (
                  <FieldRow label={tp('fields.notes')}>
                    <p className="whitespace-pre-wrap">{readField(fields, 'notes')}</p>
                  </FieldRow>
                )}
              </>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            {tp('detail.updated')} <TimeAgo value={item.updatedAt} />
            <span className="ml-1">· v{item.version}</span>
          </p>
          <p className="text-xs text-muted-foreground">{tp('detail.auditNote')}</p>

          <DialogFooter className="gap-2 sm:justify-between">
            {canEdit ? (
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => void startEdit()}>
                  <Pencil className="mr-1.5 h-4 w-4" />
                  {tp('detail.edit')}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => onMove(item)}>
                  <FolderInput className="mr-1.5 h-4 w-4" />
                  {tp('detail.move')}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => onHistory(item)}>
                  <History className="mr-1.5 h-4 w-4" />
                  {tp('detail.history')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="text-destructive"
                  onClick={() => setConfirmingDelete(true)}
                >
                  <Trash2 className="mr-1.5 h-4 w-4" />
                  {tp('detail.delete')}
                </Button>
              </div>
            ) : (
              <span />
            )}
            <Button type="button" variant="outline" onClick={onClose}>
              {tp('common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={tp('detail.deleteTitle', { title: item.title })}
        description={tp('detail.deleteDescription')}
        confirmLabel={tp('detail.delete')}
        cancelLabel={tp('common.cancel')}
        variant="destructive"
        onConfirm={remove}
      />
    </>
  );
}

function MaskedValue() {
  return <span className="font-mono text-xs text-muted-foreground">{MASK}</span>;
}
