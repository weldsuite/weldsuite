import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Switch } from '@weldsuite/ui/components/switch';
import { Label } from '@weldsuite/ui/components/label';
import { Badge } from '@weldsuite/ui/components/badge';
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
import { useAssignMailAccountUsers } from '@/hooks/queries/use-mail-queries';
import { useWorkspaceMembers } from '@/hooks/queries/use-settings-queries';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';

interface ManageAccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  accountEmail: string;
  defaultIsShared: boolean;
  defaultAssignedUserIds: string[];
}

interface WorkspaceMemberOption {
  userId?: string;
  name?: string | null;
  email?: string;
  picture?: string | null;
}

export function ManageAccessDialog({
  open,
  onOpenChange,
  accountId,
  accountEmail,
  defaultIsShared,
  defaultAssignedUserIds,
}: ManageAccessDialogProps) {
  const ts = getTranslations('settings');
  const tma = ts.weldmail.manageAccess;
  const [isShared, setIsShared] = useState(defaultIsShared);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>(defaultAssignedUserIds);
  const [pickerOpen, setPickerOpen] = useState(false);
  const assignMutation = useAssignMailAccountUsers();
  const { data: membersData, isLoading: membersLoading } = useWorkspaceMembers(1, 100);

  // Reset when dialog opens with new data
  useEffect(() => {
    if (open) {
      setIsShared(defaultIsShared);
      setSelectedUserIds(defaultAssignedUserIds);
    }
  }, [open, defaultIsShared, defaultAssignedUserIds]);

  const members = (membersData?.data ?? []) as WorkspaceMemberOption[];

  const toggleUser = (userId: string) => {
    setSelectedUserIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
    );
  };

  const handleSave = async () => {
    // If the user manually picked every workspace member, persist this as a
    // shared account — semantically identical, and keeps the "Shared" badge
    // in sync without requiring the user to flip the toggle.
    const allMemberIds = members
      .map((m) => m.userId)
      .filter((id): id is string => !!id);
    const allSelected =
      allMemberIds.length > 0 &&
      allMemberIds.every((id) => selectedUserIds.includes(id));
    const effectiveIsShared = isShared || (!isShared && allSelected);

    try {
      await assignMutation.mutateAsync({
        id: accountId,
        isShared: effectiveIsShared,
        assignedUserIds: effectiveIsShared ? [] : selectedUserIds,
      });
      toast.success(tma.messages.updated);
      onOpenChange(false);
    } catch {
      toast.error(tma.messages.updateFailed);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tma.title}</DialogTitle>
          <DialogDescription>
            {tma.description.replace('{email}', accountEmail)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="shared-toggle">{tma.sharedAccount}</Label>
              <p className="text-xs text-muted-foreground">
                {tma.sharedAccountDescription}
              </p>
            </div>
            <Switch
              id="shared-toggle"
              checked={isShared}
              onCheckedChange={setIsShared}
            />
          </div>

          {!isShared && (
            <div className="space-y-2">
              <Label>{tma.assignedUsers}</Label>
              <p className="text-xs text-muted-foreground">
                {tma.assignedUsersDescription}
              </p>

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
                <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[var(--radix-popover-trigger-width)] p-0" align="start">
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
                            {members.filter((m): m is WorkspaceMemberOption & { userId: string } => !!m.userId).map((member) => {
                              const checked = selectedUserIds.includes(member.userId);
                              const displayName = member.name || member.email || 'Member';
                              return (
                                <CommandItem
                                  key={member.userId}
                                  value={`${member.name || ''} ${member.email || ''}`}
                                  onSelect={() => toggleUser(member.userId)}
                                  className={cn(
                                    'flex items-center gap-3',
                                    checked && 'bg-muted',
                                  )}
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
                            <AvatarImage src={member.picture} alt={displayName} className="!rounded-[6px]" />
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

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tma.cancel}
          </Button>
          <Button onClick={handleSave} disabled={assignMutation.isPending}>
            {assignMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                {tma.saving}
              </>
            ) : (
              tma.save
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
