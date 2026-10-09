
import { useState } from 'react';
import { useUser, useReverification } from '@clerk/clerk-react';
import { isReverificationCancelledError } from '@clerk/clerk-react/errors';
import type { PasskeyResource } from '@clerk/types';
import { formatDistanceToNow, format } from 'date-fns';
import { EllipsisVertical, Fingerprint, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { getClerkErrorMessage } from '@/app/auth/utils';
import { getPasskeyErrorCode, isPasskeyDismissed, isPasskeySupported } from '@/lib/passkeys';

/**
 * Settings → Security: the signed-in user's Clerk passkeys. Registering and
 * removing a passkey are sensitive actions, so both go through Clerk's
 * reverification (the user re-confirms their identity in Clerk's modal when
 * the session is not fresh enough).
 */
export function PasskeysSection() {
  const { user } = useUser();
  const { t } = useI18n();
  const tp = t.settings.security.passkeys;

  const [supported] = useState(() => isPasskeySupported());
  const [isAdding, setIsAdding] = useState(false);
  const [renaming, setRenaming] = useState<PasskeyResource | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);
  const [removing, setRemoving] = useState<PasskeyResource | null>(null);

  const createPasskey = useReverification(async () => user?.createPasskey());
  const deletePasskey = useReverification((passkey: PasskeyResource) => passkey.delete());

  const passkeys = user?.passkeys ?? [];
  const displayName = (passkey: PasskeyResource) => passkey.name || tp.unnamed;

  const handleAdd = async () => {
    if (!user) return;
    setIsAdding(true);
    try {
      await createPasskey();
      await user.reload();
      toast.success(tp.messages.added);
    } catch (error) {
      if (isReverificationCancelledError(error)) return;
      if (getPasskeyErrorCode(error) === 'passkey_already_exists') {
        toast.error(tp.messages.alreadyExists);
      } else if (isPasskeyDismissed(error)) {
        toast(tp.messages.cancelled);
      } else {
        console.error('Failed to add passkey:', error);
        toast.error(tp.messages.addFailed.replace('{error}', getClerkErrorMessage(error, t.settings.security.unknown)));
      }
    } finally {
      setIsAdding(false);
    }
  };

  const openRename = (passkey: PasskeyResource) => {
    setRenameValue(passkey.name ?? '');
    setRenaming(passkey);
  };

  const handleRename = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = renameValue.trim();
    if (!renaming || !user || !name) return;
    setIsRenaming(true);
    try {
      await renaming.update({ name });
      await user.reload();
      toast.success(tp.messages.renamed);
      setRenaming(null);
    } catch (error) {
      console.error('Failed to rename passkey:', error);
      toast.error(tp.messages.renameFailed.replace('{error}', getClerkErrorMessage(error, t.settings.security.unknown)));
    } finally {
      setIsRenaming(false);
    }
  };

  const handleRemove = async () => {
    const passkey = removing;
    if (!passkey || !user) return;
    // Close the confirm dialog first: its focus trap would otherwise block
    // Clerk's reverification modal if the session needs re-confirming.
    setRemoving(null);
    try {
      await deletePasskey(passkey);
      await user.reload();
      toast.success(tp.messages.removed);
    } catch (error) {
      if (isReverificationCancelledError(error)) return;
      console.error('Failed to remove passkey:', error);
      toast.error(tp.messages.removeFailed.replace('{error}', getClerkErrorMessage(error, t.settings.security.unknown)));
    }
  };

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h3 className="text-base font-medium">{tp.title}</h3>
          <p className="text-sm text-muted-foreground mt-0.5">{tp.description}</p>
        </div>
        {supported && (
          <Button
            variant="outline"
            size="sm"
            className="shadow-none h-[34px] shrink-0"
            disabled={isAdding || !user}
            onClick={handleAdd}
          >
            {isAdding ? (
              <Loader2 className="h-4 w-4 mr-0.5 animate-spin" />
            ) : (
              <Plus className="h-4 w-4 mr-0.5" />
            )}
            {isAdding ? tp.adding : tp.add}
          </Button>
        )}
      </div>

      {!supported && (
        <p className="mb-3 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {tp.unsupported}
        </p>
      )}

      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-[13.5px]">{tp.name}</TableHead>
              <TableHead className="text-[13.5px] w-[180px]">{tp.created}</TableHead>
              <TableHead className="text-[13.5px] w-[180px]">{tp.lastUsed}</TableHead>
              <TableHead className="text-[13.5px] w-[56px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {passkeys.length ? (
              passkeys.map((passkey) => (
                <TableRow key={passkey.id} className="group">
                  <TableCell className="h-[42px] py-0 px-3">
                    <div className="flex items-center gap-2">
                      <Fingerprint className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                      <span className="font-medium">{displayName(passkey)}</span>
                    </div>
                  </TableCell>
                  <TableCell className="h-[42px] py-0 px-3 text-sm text-muted-foreground">
                    {format(passkey.createdAt, 'PP')}
                  </TableCell>
                  <TableCell className="h-[42px] py-0 px-3 text-sm text-muted-foreground font-mono">
                    {passkey.lastUsedAt
                      ? formatDistanceToNow(passkey.lastUsedAt, { addSuffix: true })
                      : tp.never}
                  </TableCell>
                  <TableCell className="h-[42px] py-0 px-3">
                    <div className="flex justify-end">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            className="h-8 w-8 p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 transition-opacity"
                          >
                            <span className="sr-only">{t.common.actions.openMenu}</span>
                            <EllipsisVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openRename(passkey)}>
                            <Pencil className="h-4 w-4 mr-0.5" />
                            {tp.rename}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => setRemoving(passkey)}
                            className="text-destructive focus:text-destructive focus:bg-destructive/10"
                          >
                            <Trash2 className="h-4 w-4 mr-0.5 text-destructive" />
                            {tp.remove}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={4} className="h-20 text-center text-muted-foreground">
                  {tp.empty}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={!!renaming} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent className="sm:max-w-[420px]">
          <form onSubmit={handleRename}>
            <DialogHeader>
              <DialogTitle>{tp.renameTitle}</DialogTitle>
              <DialogDescription>{tp.renameDescription}</DialogDescription>
            </DialogHeader>
            <Input
              className="mt-4"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              maxLength={100}
              disabled={isRenaming}
              aria-label={tp.name}
              autoFocus
            />
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setRenaming(null)} disabled={isRenaming}>
                {tp.cancel}
              </Button>
              <Button type="submit" disabled={isRenaming || !renameValue.trim()}>
                {isRenaming && <Loader2 className="h-4 w-4 mr-0.5 animate-spin" />}
                {tp.save}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={tp.removeTitle}
        description={tp.removeDescription.replace('{name}', removing ? displayName(removing) : '')}
        confirmLabel={tp.removeConfirm}
        cancelLabel={tp.cancel}
        variant="destructive"
        onConfirm={handleRemove}
      />
    </div>
  );
}
