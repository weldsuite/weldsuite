import { Check, ChevronsUpDown, Copy, Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useUser } from '@clerk/clerk-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import type {
  DriveGeneralAccess,
  DriveItemSharing,
  DriveSharePerson,
  DriveShareRole,
} from '@weldsuite/core-api-client/schemas/drive-shares';
import { DRIVE_GENERAL_ACCESS } from '@weldsuite/core-api-client/schemas/drive-shares';
import type { DriveFolder, UnifiedFile } from '@/lib/api/domains/welddrive';
import { useI18n } from '@/lib/i18n/provider';
import { copyText } from '@/lib/clipboard';
import { useWorkspaceMembers, type WorkspaceMember } from '@/hooks/queries/use-settings-queries';
import {
  useDriveItemSharing,
  useSetDriveGeneralAccess,
  useShareDriveItem,
  useUnshareDriveItem,
  type DriveItemRef,
} from '@/hooks/queries/use-drive-queries';
import {
  DriveAccessList,
  DriveGeneralAccessLine,
  GENERAL_ACCESS_ICON,
  PersonAvatar,
  personLabel,
} from './drive-access-list';
import { driveItemLink, isDriveUpload } from './drive-utils';

/** What the Share dialog is open for. */
export type DriveShareTarget =
  | { kind: 'file'; file: UnifiedFile }
  | { kind: 'folder'; folder: DriveFolder }
  /**
   * A drive file shared from the module that opens it (a WeldDocs document): its id, name and in-app link.
   * `recordFile`: the module keeps it for one of its records (a WeldFlow project sheet), whose access it follows.
   */
  | { kind: 'item'; fileId: string; name: string; link: string; recordFile?: boolean };

interface ShareDialogProps {
  target: DriveShareTarget | null;
  onOpenChange: (open: boolean) => void;
}

function targetName(target: DriveShareTarget | null): string {
  if (!target) return '';
  if (target.kind === 'item') return target.name;
  return target.kind === 'file' ? target.file.name : target.folder.name;
}

function targetLink(target: DriveShareTarget | null): string | null {
  if (!target) return null;
  if (target.kind === 'item') return target.link;
  if (target.kind === 'file') return driveItemLink(target.file);
  return `${window.location.origin}/welddrive?folderId=${encodeURIComponent(target.folder.id)}`;
}

/** Drive's own items have sharing; a file a module keeps for a record follows that module. */
function sharingItem(target: DriveShareTarget | null): DriveItemRef | null {
  if (!target) return null;
  if (target.kind === 'folder') return { kind: 'folder', id: target.folder.id };
  if (target.kind === 'item') return target.recordFile ? null : { kind: 'file', id: target.fileId };
  return isDriveUpload(target.file) ? { kind: 'file', id: target.file.id } : null;
}

/** Workspace members who can be added: active, and not already on the list. */
function shareCandidates(members: WorkspaceMember[], sharing: DriveItemSharing | undefined, selfId: string | undefined): WorkspaceMember[] {
  const present = new Set<string>([
    ...(sharing?.owner ? [sharing.owner.userId] : []),
    ...(sharing?.shares.map((s) => s.userId) ?? []),
    ...(selfId ? [selfId] : []),
  ]);
  return members.filter(
    (m) => !present.has(m.userId) && (!m.status || m.status.toUpperCase() === 'ACTIVE'),
  );
}

function TeammatePicker({ candidates, selected, onSelect, disabled }: Readonly<{
  candidates: WorkspaceMember[];
  selected: WorkspaceMember | null;
  onSelect: (member: WorkspaceMember) => void;
  disabled?: boolean;
}>) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="h-9 flex-1 min-w-0 justify-between font-normal"
        >
          <span className={selected ? 'truncate' : 'truncate text-muted-foreground'}>
            {selected ? personLabel({ ...selected, name: selected.name ?? null, email: selected.email ?? null }) : t.welddrive.share.addPeople}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder={t.welddrive.share.searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{t.welddrive.share.noTeammates}</CommandEmpty>
            <CommandGroup>
              {candidates.map((member) => {
                const person: DriveSharePerson = {
                  userId: member.userId,
                  name: member.name ?? null,
                  email: member.email ?? null,
                  picture: member.picture ?? null,
                };
                return (
                  <CommandItem
                    key={member.userId}
                    value={`${member.name ?? ''} ${member.email ?? ''} ${member.userId}`}
                    onSelect={() => {
                      onSelect(member);
                      setOpen(false);
                    }}
                  >
                    <PersonAvatar person={person} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{personLabel(person)}</p>
                      {member.name && member.email && (
                        <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                      )}
                    </div>
                    {selected?.userId === member.userId && <Check className="h-4 w-4" />}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function SharingBody({ item, sharing, onLeft }: Readonly<{
  item: DriveItemRef;
  sharing: DriveItemSharing;
  onLeft: () => void;
}>) {
  const { t } = useI18n();
  const { user } = useUser();
  const { data: membersData } = useWorkspaceMembers(undefined, 100);
  const share = useShareDriveItem();
  const unshare = useUnshareDriveItem();
  const setGeneralAccess = useSetDriveGeneralAccess();
  const [selected, setSelected] = useState<WorkspaceMember | null>(null);
  const [newRole, setNewRole] = useState<DriveShareRole>('viewer');

  const canManage = sharing.accessRole !== 'viewer';
  const candidates = useMemo(
    () => shareCandidates(membersData?.data ?? [], sharing, user?.id),
    [membersData, sharing, user?.id],
  );
  const busy = share.isPending || unshare.isPending || setGeneralAccess.isPending;

  const handleShare = () => {
    if (!selected) return;
    const name = personLabel({ userId: selected.userId, name: selected.name ?? null, email: selected.email ?? null });
    share.mutate(
      { item, userId: selected.userId, role: newRole },
      {
        onSuccess: () => {
          toast.success(t.welddrive.toasts.sharedWith.replace('{name}', name));
          setSelected(null);
          setNewRole('viewer');
        },
        onError: () => toast.error(t.welddrive.toasts.failedToShare),
      },
    );
  };

  const handleRoleChange = (person: DriveSharePerson, role: DriveShareRole) => {
    share.mutate(
      { item, userId: person.userId, role },
      {
        onSuccess: () => toast.success(t.welddrive.toasts.accessUpdated),
        onError: () => toast.error(t.welddrive.toasts.failedToUpdateAccess),
      },
    );
  };

  const handleRemove = (person: DriveSharePerson) => {
    const leaving = person.userId === user?.id;
    unshare.mutate(
      { item, userId: person.userId },
      {
        onSuccess: () => {
          if (leaving) {
            toast.success(t.welddrive.toasts.leftSharedItem);
            onLeft();
          } else {
            toast.success(t.welddrive.toasts.accessRemoved.replace('{name}', personLabel(person)));
          }
        },
        onError: () => toast.error(t.welddrive.toasts.failedToUpdateAccess),
      },
    );
  };

  const handleGeneralAccess = (generalAccess: DriveGeneralAccess) => {
    if (generalAccess === sharing.generalAccess) return;
    setGeneralAccess.mutate(
      { item, generalAccess },
      {
        onSuccess: () => toast.success(t.welddrive.toasts.accessUpdated),
        onError: () => toast.error(t.welddrive.toasts.failedToUpdateAccess),
      },
    );
  };

  return (
    <div className="space-y-5">
      {canManage && (
        <div className="flex items-center gap-2">
          <TeammatePicker candidates={candidates} selected={selected} onSelect={setSelected} disabled={busy} />
          <Select value={newRole} onValueChange={(v) => setNewRole(v as DriveShareRole)} disabled={busy}>
            <SelectTrigger className="h-9 w-[110px] shrink-0" aria-label={t.welddrive.share.addPeople}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {(['viewer', 'editor'] as const).map((role) => (
                <SelectItem key={role} value={role}>
                  <div>
                    <p>{t.welddrive.share.roles[role]}</p>
                    <p className="text-xs text-muted-foreground">{t.welddrive.share.roleDescriptions[role]}</p>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button className="h-9 shrink-0" onClick={handleShare} disabled={!selected || busy}>
            {share.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            {t.welddrive.share.shareButton}
          </Button>
        </div>
      )}

      <div>
        <p className="text-sm font-medium text-foreground mb-3">{t.welddrive.share.peopleWithAccess}</p>
        <DriveAccessList
          sharing={sharing}
          editable={canManage}
          onRoleChange={handleRoleChange}
          onRemove={handleRemove}
          disabled={busy}
        />
      </div>

      <div>
        <p className="text-sm font-medium text-foreground mb-2">{t.welddrive.share.generalAccess}</p>
        {canManage ? (
          <div className="space-y-1.5">
            <Select value={sharing.generalAccess} onValueChange={(v) => handleGeneralAccess(v as DriveGeneralAccess)} disabled={busy}>
              <SelectTrigger className="h-9 w-full" aria-label={t.welddrive.share.generalAccess}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DRIVE_GENERAL_ACCESS.map((access) => {
                  const Icon = GENERAL_ACCESS_ICON[access];
                  return (
                    <SelectItem key={access} value={access}>
                      <span className="flex items-center gap-2">
                        <Icon className="h-4 w-4 text-muted-foreground" />
                        {t.welddrive.share.generalAccessOptions[access]}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t.welddrive.share.generalAccessHints[sharing.generalAccess]}</p>
          </div>
        ) : (
          <DriveGeneralAccessLine access={sharing.effectiveGeneralAccess} />
        )}
        {sharing.effectiveGeneralAccess !== sharing.generalAccess && (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{t.welddrive.share.restrictedByFolder}</p>
        )}
      </div>

      {!canManage && <p className="text-xs text-muted-foreground">{t.welddrive.share.viewOnlyNote}</p>}
      <p className="text-xs text-muted-foreground">{t.welddrive.share.adminNote}</p>
    </div>
  );
}

/**
 * Share a Drive file or folder: add teammates as viewers or editors, change
 * or remove them, set general access, copy the in-app link. A folder's
 * sharing reaches everything in it. Rules: `@weldsuite/core-domain/drive-access`.
 */
export function ShareDialog({ target, onOpenChange }: Readonly<ShareDialogProps>) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const item = sharingItem(target);
  const { data: sharing, isLoading, isError } = useDriveItemSharing(item);
  const link = targetLink(target);

  const handleCopy = () => {
    if (!link) return;
    copyText(link, () => {
      setCopied(true);
      toast.success(t.welddrive.toasts.linkCopied);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) setCopied(false);
    onOpenChange(open);
  };

  return (
    <Dialog open={!!target} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">
            {t.welddrive.share.title.replace('{name}', targetName(target))}
          </DialogTitle>
          <DialogDescription>
            {target?.kind === 'folder' ? t.welddrive.share.descriptionFolder : t.welddrive.share.descriptionFile}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-1">
          {!item && target && (
            <p className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground">
              {t.welddrive.share.moduleFile}
            </p>
          )}
          {item && isLoading && (
            <div className="flex justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {item && isError && <p className="text-sm text-destructive">{t.welddrive.toasts.failedToUpdateAccess}</p>}
          {item && sharing && <SharingBody item={item} sharing={sharing} onLeft={() => onOpenChange(false)} />}

          {link && (
            <div>
              <p className="text-sm font-medium text-foreground mb-1.5">{t.welddrive.share.linkLabel}</p>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={link}
                  className="h-9 font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label={t.welddrive.share.linkLabel}
                />
                <Button variant="outline" className="h-9 shrink-0" onClick={handleCopy}>
                  {copied ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
                  {t.welddrive.share.copyLink}
                </Button>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>{t.welddrive.share.done}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
