import { useMemo, useState, type ReactNode } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { toast } from 'sonner';
import { Trash2, UserPlus } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Label } from '@weldsuite/ui/components/label';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  useCalendarShares,
  useShareCalendar,
  useRemoveCalendarShare,
} from '@/hooks/queries/use-calendar-queries';
import {
  useWorkspaceMembers,
  useWorkspaceMemberSearch,
  type WorkspaceMember,
} from '@/hooks/queries/use-settings-queries';
import { getTranslations } from '@/lib/i18n';

type SharePermission = 'view' | 'edit' | 'manage';

interface ShareCalendarDialogProps {
  calendarId: string;
  /** The calendar's owner, who is never offered as a share target. */
  ownerId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** A member as the picker and the shared-with list show them. */
interface MemberOption {
  userId: string;
  name: string;
  email: string;
}

function toOption(m: WorkspaceMember): MemberOption {
  return { userId: m.userId, name: m.name || m.email || '', email: m.email || '' };
}

function initialOf(m: Pick<MemberOption, 'name' | 'email'>): string {
  return (m.name[0] || m.email[0] || '?').toUpperCase();
}

/**
 * Share a calendar with workspace members (TASK-749). The target is picked
 * from the member list by name or email — the share is keyed on the member's
 * user id, which nobody can be expected to type.
 */
export function ShareCalendarDialog({ calendarId, ownerId, open, onOpenChange }: Readonly<ShareCalendarDialogProps>) {
  const { data: sharesData, isLoading } = useCalendarShares(calendarId);
  const shareCalendar = useShareCalendar();
  const removeShare = useRemoveCalendarShare();
  const { userId: currentUserId } = useAuth();
  const t = getTranslations('weldcalendar');

  const [search, setSearch] = useState('');
  // The highlighted member in the list; Enter and the add button share with it.
  const [highlighted, setHighlighted] = useState('');
  const [permission, setPermission] = useState<SharePermission>('view');

  const shares = useMemo(() => sharesData?.data || [], [sharesData]);

  // First page for browsing + server search so members past it stay findable.
  const { data: membersData } = useWorkspaceMembers(1, 100);
  const { data: searchData } = useWorkspaceMemberSearch(search);

  const membersById = useMemo(() => {
    const map = new Map<string, MemberOption>();
    for (const m of [...(membersData?.data ?? []), ...(searchData?.data ?? [])]) {
      if (m.userId && !map.has(m.userId)) map.set(m.userId, toOption(m));
    }
    return map;
  }, [membersData, searchData]);

  // Who can be added: active members, minus you, the owner and anyone already shared with.
  const candidates = useMemo(() => {
    const excluded = new Set<string>(shares.map((s) => s.sharedWithId));
    if (currentUserId) excluded.add(currentUserId);
    if (ownerId) excluded.add(ownerId);
    const active = new Set(
      [...(membersData?.data ?? []), ...(searchData?.data ?? [])]
        .filter((m) => !m.status || m.status.toUpperCase() === 'ACTIVE')
        .map((m) => m.userId),
    );
    return [...membersById.values()].filter((m) => active.has(m.userId) && !excluded.has(m.userId));
  }, [membersById, membersData, searchData, shares, currentUserId, ownerId]);

  const PERMISSION_LABELS: Record<string, string> = {
    view: t.shareCalendar.permissionCanView,
    edit: t.shareCalendar.permissionCanEdit,
    manage: t.shareCalendar.permissionCanManage,
  };

  const addMember = async (userId: string) => {
    if (!userId || shareCalendar.isPending) return;
    try {
      await shareCalendar.mutateAsync({ calendarId, sharedWithId: userId, permission });
      setSearch('');
      setHighlighted('');
    } catch {
      toast.error(t.shareCalendar.shareFailed);
    }
  };

  const handleRemove = async (shareId: string) => {
    try {
      await removeShare.mutateAsync({ calendarId, shareId });
    } catch {
      toast.error(t.shareCalendar.removeFailed);
    }
  };

  // The highlighted value can outlive the list it came from (e.g. right after
  // a share); only share with someone who is still a candidate.
  const highlightedCandidate = candidates.find((m) => m.userId === highlighted);

  let sharesContent: ReactNode;
  if (isLoading) {
    sharesContent = <p className="text-sm text-muted-foreground">{t.shareCalendar.loading}</p>;
  } else if (shares.length === 0) {
    sharesContent = <p className="text-sm text-muted-foreground">{t.shareCalendar.notShared}</p>;
  } else {
    sharesContent = (
      <ul className="space-y-2">
        {shares.map((share) => {
          const member = membersById.get(share.sharedWithId);
          const displayName = member?.name || t.shareCalendar.unknownMember;
          return (
            <li key={share.id} className="flex items-center justify-between gap-2 p-2 border rounded-md">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{displayName}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {member?.email ? `${member.email} · ` : ''}
                  {PERMISSION_LABELS[share.permission]}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-destructive"
                aria-label={t.shareCalendar.removeShare.replace('{name}', displayName)}
                disabled={removeShare.isPending}
                onClick={() => handleRemove(share.id)}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t.shareCalendar.title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Add member */}
          <div className="space-y-2">
            <Label>{t.shareCalendar.addMemberLabel}</Label>
            <div className="flex gap-2 items-start">
              <Command
                value={highlighted}
                onValueChange={setHighlighted}
                className="flex-1 h-auto border rounded-md"
              >
                <CommandInput
                  placeholder={t.shareCalendar.memberPlaceholder}
                  aria-label={t.shareCalendar.memberPlaceholder}
                  value={search}
                  onValueChange={setSearch}
                />
                <CommandList className="max-h-[200px]">
                  <CommandEmpty>{t.shareCalendar.noMembersFound}</CommandEmpty>
                  {candidates.map((m) => (
                    <CommandItem
                      key={m.userId}
                      value={m.userId}
                      keywords={[m.name, m.email]}
                      onSelect={() => addMember(m.userId)}
                      disabled={shareCalendar.isPending}
                      className="gap-3"
                    >
                      <span
                        aria-hidden="true"
                        className="h-6 w-6 rounded-[5.5px] bg-blue-500/10 flex items-center justify-center shrink-0 text-xs font-medium text-blue-600"
                      >
                        {initialOf(m)}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium truncate">{m.name}</span>
                        {m.email && (
                          <span className="block text-xs text-muted-foreground truncate">{m.email}</span>
                        )}
                      </span>
                    </CommandItem>
                  ))}
                </CommandList>
              </Command>
              <Select value={permission} onValueChange={(v) => setPermission(v as SharePermission)}>
                <SelectTrigger className="w-32" aria-label={t.shareCalendar.permissionLabel}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="view">{t.shareCalendar.permissionCanView}</SelectItem>
                  <SelectItem value="edit">{t.shareCalendar.permissionCanEdit}</SelectItem>
                  <SelectItem value="manage">{t.shareCalendar.permissionCanManage}</SelectItem>
                </SelectContent>
              </Select>
              <Button
                type="button"
                size="icon"
                aria-label={t.shareCalendar.addMemberLabel}
                onClick={() => highlightedCandidate && addMember(highlightedCandidate.userId)}
                disabled={shareCalendar.isPending || !highlightedCandidate}
              >
                <UserPlus className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>

          {/* Current shares */}
          <div className="space-y-2">
            <Label>{t.shareCalendar.sharedWithLabel}</Label>
            {sharesContent}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
