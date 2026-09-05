/**
 * Who can open a mail account — the shared-vs-assigned control.
 *
 * Extracted from the settings "Manage access" dialog so account CREATION can
 * offer the same choice up front instead of forcing a create-then-edit round
 * trip. Both surfaces post the same `isShared` / `assignedUserIds` pair, so the
 * normalisation below has to live in one place rather than being re-derived.
 *
 * Controlled by {@link useMailAccessSelection}, which owns the state and the
 * member fetch; the component is presentation only.
 */

import { useCallback, useMemo, useState } from 'react';
import { Switch } from '@weldsuite/ui/components/switch';
import { Label } from '@weldsuite/ui/components/label';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { Check, ChevronsUpDown, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspaceMembers } from '@/hooks/queries/use-settings-queries';
import { getTranslations } from '@/lib/i18n';

export interface MailAccessMember {
  userId?: string;
  name?: string | null;
  email?: string | null;
  picture?: string | null;
}

/** The pair every mail-account write expects. */
export interface MailAccessValue {
  isShared: boolean;
  assignedUserIds: string[];
}

export interface MailAccessSelection {
  isShared: boolean;
  setIsShared: (value: boolean) => void;
  selectedUserIds: string[];
  toggleUser: (userId: string) => void;
  members: MailAccessMember[];
  membersLoading: boolean;
  /** Normalised payload to send to the API. */
  resolve: () => MailAccessValue;
  reset: (isShared?: boolean, userIds?: string[]) => void;
}

/**
 * Owns the shared/assigned state plus the workspace member list.
 *
 * `resolve()` collapses "private, but every member is ticked" back to a shared
 * account — semantically identical, and it keeps the "Shared" badge honest
 * without making the user go back and flip the toggle.
 */
export function useMailAccessSelection(
  defaultIsShared = true,
  defaultUserIds: string[] = [],
): MailAccessSelection {
  const [isShared, setIsShared] = useState(defaultIsShared);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>(defaultUserIds);
  const { data: membersData, isLoading: membersLoading } = useWorkspaceMembers(1, 100);

  const members = useMemo(
    () => (membersData?.data ?? []) as MailAccessMember[],
    [membersData],
  );

  const toggleUser = useCallback((userId: string) => {
    setSelectedUserIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
    );
  }, []);

  const resolve = useCallback((): MailAccessValue => {
    const allMemberIds = members
      .map((m) => m.userId)
      .filter((id): id is string => !!id);
    const allSelected =
      allMemberIds.length > 0 && allMemberIds.every((id) => selectedUserIds.includes(id));
    const effectiveIsShared = isShared || allSelected;
    return {
      isShared: effectiveIsShared,
      assignedUserIds: effectiveIsShared ? [] : selectedUserIds,
    };
  }, [isShared, selectedUserIds, members]);

  const reset = useCallback((shared = defaultIsShared, userIds = defaultUserIds) => {
    setIsShared(shared);
    setSelectedUserIds(userIds);
  }, [defaultIsShared, defaultUserIds]);

  return {
    isShared,
    setIsShared,
    selectedUserIds,
    toggleUser,
    members,
    membersLoading,
    resolve,
    reset,
  };
}

export function MailAccessPicker({
  selection,
  idPrefix = 'mail-access',
}: {
  selection: MailAccessSelection;
  /** Distinguishes the switch when two pickers share a page. */
  idPrefix?: string;
}) {
  const tma = getTranslations('settings').weldmail.manageAccess;
  const [pickerOpen, setPickerOpen] = useState(false);
  const { isShared, setIsShared, selectedUserIds, toggleUser, members, membersLoading } =
    selection;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label htmlFor={`${idPrefix}-shared-toggle`}>{tma.sharedAccount}</Label>
          <p className="text-xs text-muted-foreground">{tma.sharedAccountDescription}</p>
        </div>
        <Switch
          id={`${idPrefix}-shared-toggle`}
          checked={isShared}
          onCheckedChange={setIsShared}
        />
      </div>

      {!isShared && (
        <div className="space-y-2">
          <Label>{tma.assignedUsers}</Label>
          <p className="text-xs text-muted-foreground">{tma.assignedUsersDescription}</p>

          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                role="combobox"
                aria-expanded={pickerOpen}
                className="w-full justify-between font-normal"
              >
                <span className="text-muted-foreground">
                  {selectedUserIds.length === 0
                    ? tma.selectUsers
                    : selectedUserIds.length === 1
                      ? tma.usersSelected.replace('{count}', String(selectedUserIds.length))
                      : tma.usersSelectedPlural.replace('{count}', String(selectedUserIds.length))}
                </span>
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="w-[var(--radix-popover-trigger-width)] min-w-[var(--radix-popover-trigger-width)] p-0"
              align="start"
            >
              <Command>
                <CommandInput placeholder={tma.searchUsers} />
                <CommandList>
                  {membersLoading ? (
                    <div className="flex items-center justify-center gap-2 py-8">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      <span className="text-sm text-muted-foreground">{tma.loading}</span>
                    </div>
                  ) : (
                    <>
                      <CommandEmpty>{tma.noUsersFound}</CommandEmpty>
                      <CommandGroup>
                        {members
                          .filter((m): m is MailAccessMember & { userId: string } => !!m.userId)
                          .map((member) => {
                            const checked = selectedUserIds.includes(member.userId);
                            const displayName = member.name || member.email || 'Member';
                            return (
                              <CommandItem
                                key={member.userId}
                                value={`${member.name || ''} ${member.email || ''}`}
                                onSelect={() => toggleUser(member.userId)}
                                className={cn('flex items-center gap-3', checked && 'bg-muted')}
                              >
                                <Avatar className="h-6 w-6 !rounded-[8px] shrink-0">
                                  {member.picture && (
                                    <AvatarImage
                                      src={member.picture}
                                      alt={displayName}
                                      className="!rounded-[8px]"
                                    />
                                  )}
                                  <AvatarFallback className="!rounded-[8px] text-[10px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
                                    {displayName.charAt(0).toUpperCase()}
                                  </AvatarFallback>
                                </Avatar>
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium truncate">
                                    {member.name || member.email}
                                  </p>
                                  {member.name && (
                                    <p className="text-xs text-muted-foreground truncate">
                                      {member.email}
                                    </p>
                                  )}
                                </div>
                                <Check
                                  className={cn(
                                    'h-4 w-4 ml-auto',
                                    checked ? 'opacity-100' : 'opacity-0',
                                  )}
                                />
                              </CommandItem>
                            );
                          })}
                      </CommandGroup>
                    </>
                  )}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>

          {selectedUserIds.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {selectedUserIds.map((userId) => {
                const member = members.find((m) => m.userId === userId);
                const displayName = member?.name || member?.email || userId;
                return (
                  <Badge
                    key={userId}
                    variant="secondary"
                    className="gap-1.5 pl-1 pr-1.5 py-1 !rounded-md"
                  >
                    <Avatar className="h-[18px] w-[18px] !rounded-[6px]">
                      {member?.picture && (
                        <AvatarImage
                          src={member.picture}
                          alt={displayName}
                          className="!rounded-[6px]"
                        />
                      )}
                      <AvatarFallback className="!rounded-[6px] text-[9px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
                        {displayName.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    {displayName}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => toggleUser(userId)}
                      className="rounded-sm p-0.5 text-gray-600 dark:text-muted-foreground hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </Badge>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
