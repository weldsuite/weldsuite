/**
 * One password-manager item.
 *
 * Nothing secret is on screen, or even in memory, until the user asks: opening
 * the dialog only shows what the list already carried (title, username, site).
 * Reveal, copying a secret and Edit each make one audited reveal request.
 * Revealed values live in this component's state and go away when it unmounts.
 */

import { useId, useState } from 'react';
import { ExternalLink, Eye, EyeOff, Loader2 } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupTextarea,
} from '@weldsuite/ui/components/input-group';
import { Label } from '@weldsuite/ui/components/label';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
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
import { cn } from '@/lib/utils';
import { safeHref } from '../lib/items';
import { usePasswordsT } from '../lib/use-passwords-t';
import { CopyButton } from './copy-button';
import { ItemHistoryPanel } from './item-history-panel';
import { TotpCode } from './totp-code';

const MASK = '••••••••••••';

type DetailTab = 'details' | 'history';

/** A field of the revealed document, by name. Every field is a string. */
function readField(fields: WeldPassItemFields, key: string): string {
  return (fields as Record<string, string>)[key] ?? '';
}

function Field({
  label,
  htmlFor,
  children,
}: Readonly<{ label: string; htmlFor?: string; children: React.ReactNode }>) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

/** A value shown in a read-only input, with its actions inside the right edge. */
function ReadOnlyField({
  label,
  value,
  mono,
  multiline,
  actions,
}: Readonly<{
  label: string;
  value: string;
  mono?: boolean;
  multiline?: boolean;
  actions?: React.ReactNode;
}>) {
  const id = useId();
  const className = cn(mono && 'font-mono');
  return (
    <Field label={label} htmlFor={id}>
      <InputGroup>
        {multiline ? (
          <InputGroupTextarea id={id} readOnly value={value} className={className} />
        ) : (
          <InputGroupInput id={id} readOnly value={value} placeholder="—" className={className} />
        )}
        {actions && (
          <InputGroupAddon align="inline-end" className="gap-1">
            {actions}
          </InputGroupAddon>
        )}
      </InputGroup>
    </Field>
  );
}

export function ItemDetailDialog({
  item,
  vaultName,
  canEdit,
  onClose,
  onEdit,
  onMove,
  onRestored,
}: Readonly<{
  item: WeldPassItem;
  vaultName: string;
  canEdit: boolean;
  onClose: () => void;
  /** Receives the decrypted item to prefill the form with. */
  onEdit: (revealed: WeldPassRevealedItem) => void;
  onMove: (item: WeldPassItem) => void;
  /** Fired after an earlier version was restored from the History tab. */
  onRestored: () => void;
}>) {
  const tp = usePasswordsT();
  const reveal = useRevealWeldPassItem();
  const deleteItem = useDeleteWeldPassItem();

  const [revealed, setRevealed] = useState<WeldPassRevealedItem | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [tab, setTab] = useState<DetailTab>('details');

  // History lists what was saved and can roll it back, so it follows the
  // write actions: editors and up.
  const tabs: PageTab[] = [
    { id: 'details', label: tp('detail.tabDetails') },
    ...(canEdit ? [{ id: 'history', label: tp('detail.history') }] : []),
  ];

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
      size="icon-xs"
      onClick={() => void toggleReveal()}
      disabled={reveal.isPending}
      aria-label={revealed ? tp('detail.hide') : tp('detail.reveal')}
      title={revealed ? tp('detail.hide') : tp('detail.reveal')}
    >
      {reveal.isPending && <Loader2 className="size-3.5 animate-spin" />}
      {!reveal.isPending &&
        (revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />)}
    </Button>
  );

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent
          className="sm:max-w-[38rem]"
          aria-describedby={undefined}
          // Focus the dialog, not its first field: a read-only input with a
          // focus ring reads as editable.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement).focus();
          }}
        >
          <DialogHeader>
            <DialogTitle className="truncate pr-6 leading-6">{item.title}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <PageTabs
              tabs={tabs}
              activeTab={tab}
              onTabChange={(id) => setTab(id as DetailTab)}
              className="mb-5"
            />

            <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

            {tab === 'history' && (
              <ItemHistoryPanel
                item={item}
                onRestored={() => {
                  // The revealed copy is the old version now.
                  setRevealed(null);
                  setTab('details');
                  onRestored();
                }}
              />
            )}

            {tab === 'details' && (
              <>
                {item.type === 'login' && (
                  <>
                    <ReadOnlyField
                      label={tp('fields.username')}
                      value={item.subtitle ?? ''}
                      actions={
                        item.subtitle ? (
                          // The username is on the list already; no reveal needed.
                          <CopyButton
                            compact
                            resolve={() => item.subtitle ?? ''}
                            label={tp('detail.copyUsername')}
                          />
                        ) : undefined
                      }
                    />

                    <ReadOnlyField
                      label={tp('fields.password')}
                      value={fields ? readField(fields, 'password') : MASK}
                      mono
                      actions={
                        <>
                          {revealButton}
                          <CopyButton
                            compact
                            resolve={copyField('password')}
                            label={tp('detail.copyPassword')}
                            onError={copyError}
                          />
                        </>
                      }
                    />

                    {href && (
                      <ReadOnlyField
                        label={tp('fields.website')}
                        value={item.url ?? ''}
                        actions={
                          <Button asChild variant="ghost" size="icon-xs" className="-mr-2">
                            <a
                              href={href}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={tp('detail.openWebsite')}
                              title={tp('detail.openWebsite')}
                            >
                              <ExternalLink className="size-3.5" />
                            </a>
                          </Button>
                        }
                      />
                    )}

                    {item.hasTotp && (
                      <Field label={tp('fields.totp')}>
                        <TotpCode vaultId={item.vaultId} itemId={item.id} />
                      </Field>
                    )}

                    {fields && readField(fields, 'notes') && (
                      <ReadOnlyField
                        label={tp('fields.notes')}
                        value={readField(fields, 'notes')}
                        multiline
                      />
                    )}
                  </>
                )}

                {item.type === 'note' && (
                  <ReadOnlyField
                    label={tp('fields.content')}
                    value={fields ? readField(fields, 'content') : MASK}
                    mono={!fields}
                    multiline={!!fields}
                    actions={revealButton}
                  />
                )}

                {item.type === 'card' && (
                  <>
                    <ReadOnlyField
                      label={tp('fields.number')}
                      value={fields ? readField(fields, 'number') : item.subtitle || MASK}
                      mono
                      actions={
                        <>
                          {revealButton}
                          <CopyButton
                            compact
                            resolve={copyField('number')}
                            label={tp('detail.copyNumber')}
                            onError={copyError}
                          />
                        </>
                      }
                    />
                    <ReadOnlyField
                      label={tp('fields.cardholder')}
                      value={fields ? readField(fields, 'cardholder') : MASK}
                      mono={!fields}
                    />
                    <div className="grid grid-cols-2 gap-4">
                      <ReadOnlyField
                        label={tp('fields.expiry')}
                        value={fields ? readField(fields, 'expiry') : MASK}
                        mono={!fields}
                      />
                      <ReadOnlyField
                        label={tp('fields.cvc')}
                        value={fields ? readField(fields, 'cvc') : MASK}
                        mono={!fields}
                        actions={
                          <CopyButton
                            compact
                            resolve={copyField('cvc')}
                            label={tp('detail.copyCvc')}
                            onError={copyError}
                          />
                        }
                      />
                    </div>
                    {fields && readField(fields, 'notes') && (
                      <ReadOnlyField
                        label={tp('fields.notes')}
                        value={readField(fields, 'notes')}
                        multiline
                      />
                    )}
                  </>
                )}

                <div className="space-y-1 text-xs text-muted-foreground">
                  <p className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="secondary">{tp(`types.${item.type}`)}</Badge>
                    <span>{vaultName}</span>
                    <span aria-hidden>·</span>
                    <span>
                      {tp('detail.updated')} <TimeAgo value={item.updatedAt} /> · v{item.version}
                    </span>
                  </p>
                  <p>{tp('detail.auditNote')}</p>
                </div>
              </>
            )}

            {canEdit && (
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setConfirmingDelete(true)}
                >
                  {tp('detail.delete')}
                </Button>
                <Button type="button" variant="outline" onClick={() => onMove(item)}>
                  {tp('detail.move')}
                </Button>
                <Button type="button" onClick={() => void startEdit()}>
                  {tp('detail.edit')}
                </Button>
              </DialogFooter>
            )}
          </div>
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
