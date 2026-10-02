import { useState, useMemo } from 'react';
import type { KeyboardEvent } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { ArrowDown, ArrowUp, Check } from 'lucide-react';
import {
  useCreateDm,
  useWorkspaceMembers,
} from '@/hooks/queries/use-weldchat-queries';
import { useNavigate } from '@tanstack/react-router';
import { useI18n } from '@/lib/i18n/provider';

interface DmCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface DmMember {
  id: string;
  userId?: string;
  name?: string;
  email?: string;
  picture?: string;
}

const memberKey = (m: DmMember) => m.userId || m.id;

function MemberAvatar({ member }: Readonly<{ member: DmMember }>) {
  return (
    <Avatar className="size-5 flex-shrink-0 !rounded-[6px]">
      {member.picture && <AvatarImage src={member.picture} alt={member.name} className="!rounded-[6px]" />}
      <AvatarFallback className="text-[10px] !rounded-[6px]">
        {(member.name || member.email || '?')[0].toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

/** Small keycap used in the footer navigation hint. */
function KeyCap({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <span className="inline-flex size-5 items-center justify-center rounded-[5px] border border-border bg-muted/50 text-muted-foreground">
      {children}
    </span>
  );
}

export function DmCreateDialog({ open, onOpenChange }: Readonly<DmCreateDialogProps>) {
  const { t } = useI18n();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // cmdk's highlighted row (its value is the member key).
  const [highlightedId, setHighlightedId] = useState('');
  const navigate = useNavigate();
  const { data: membersData } = useWorkspaceMembers();
  const { mutate: createDm, isPending } = useCreateDm();

  const members = useMemo<DmMember[]>(() => membersData?.data || [], [membersData]);

  const toggleMember = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const startConversation = (userIds: string[]) => {
    if (userIds.length === 0 || isPending) return;

    // 1:1 DM — just navigate to the user, channel auto-resolves
    if (userIds.length === 1) {
      onOpenChange(false);
      setSelectedIds([]);
      navigate({
        to: '/weldchat/dm/$userId',
        params: { userId: userIds[0] },
      });
      return;
    }

    // Group DM (3+ participants) — use POST /chat/dm
    createDm(
      { userIds },
      {
        onSuccess: (data) => {
          onOpenChange(false);
          setSelectedIds([]);
          const channelId = data?.data?.id;
          if (channelId) {
            navigate({
              to: '/weldchat/dm/group/$channelId',
              params: { channelId },
            });
          }
        },
      }
    );
  };

  // Enter starts the conversation (same as the button) instead of toggling
  // the row: with the current selection, or the highlighted person
  // when nothing is selected yet. Clicking a row toggles it.
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault(); // cmdk skips its own Enter handling when prevented
    startConversation(selectedIds.length > 0 ? selectedIds : highlightedId ? [highlightedId] : []);
  };

  const canStart = (selectedIds.length > 0 || !!highlightedId) && !isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Close button: 28x28 (p-1.5 around the 16px icon), nudged in 2px so its center stays put. */}
      <DialogContent
        className="gap-0 overflow-hidden p-0 outline-none sm:max-w-[540px] [&_[data-slot=dialog-close]]:top-3.5 [&_[data-slot=dialog-close]]:right-3.5 [&_[data-slot=dialog-close]]:p-1.5"
        aria-describedby={undefined}
      >
        <DialogHeader className="px-4 pb-4 pt-5">
          <DialogTitle>{t.weldchat.dmCreate.title}</DialogTitle>
        </DialogHeader>
        {/* Search is a standalone field (shadcn Input look) rather than a
            full-width strip joined to the header and list. */}
        <Command
          value={highlightedId}
          onValueChange={setHighlightedId}
          onKeyDown={handleKeyDown}
          className="overflow-hidden rounded-none bg-transparent [&_[data-slot=command-input-wrapper]]:mx-4 [&_[data-slot=command-input-wrapper]]:rounded-md [&_[data-slot=command-input-wrapper]]:border [&_[data-slot=command-input-wrapper]]:border-input [&_[data-slot=command-input-wrapper]]:shadow-xs [&_[data-slot=command-input-wrapper]]:transition-[color,box-shadow] dark:[&_[data-slot=command-input-wrapper]]:bg-input/30 [&_[data-slot=command-input-wrapper]:focus-within]:border-ring [&_[data-slot=command-input-wrapper]:focus-within]:ring-[3px] [&_[data-slot=command-input-wrapper]:focus-within]:ring-ring/50"
        >
          <CommandInput placeholder={t.weldchat.dmCreate.searchPeople} autoFocus />
          <CommandList className="mt-2">
            <CommandEmpty>{t.weldchat.dmCreate.noResults}</CommandEmpty>
            <CommandGroup
              heading={t.weldchat.dmCreate.people}
              className="px-2 pb-2 pt-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
            >
              {members.map((member) => {
                const id = memberKey(member);
                const isSelected = selectedIds.includes(id);
                return (
                  <CommandItem
                    key={id}
                    value={id}
                    keywords={[member.name ?? '', member.email ?? '']}
                    onSelect={() => toggleMember(id)}
                    className="gap-2 rounded-md px-2 py-2"
                  >
                    <MemberAvatar member={member} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                      {member.name || member.email}
                    </span>
                    {/* Check sits before the email so the email's position
                        doesn't shift when a row is selected. */}
                    {isSelected && <Check className="size-4 text-primary" />}
                    {member.name && member.email && (
                      <span className="mr-1 min-w-0 max-w-[55%] truncate text-right text-[13px] text-muted-foreground">
                        {member.email}
                      </span>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
        <div className="flex items-center justify-between border-t px-3 py-2">
          <div className="flex items-center gap-1 text-sm text-muted-foreground">
            <KeyCap><ArrowUp className="size-3" /></KeyCap>
            <KeyCap><ArrowDown className="size-3" /></KeyCap>
            <span className="ml-1.5">{t.weldchat.dmCreate.navigate}</span>
          </div>
          <Button
            onClick={() => startConversation(selectedIds.length > 0 ? selectedIds : [highlightedId])}
            disabled={!canStart}
            className="shadow-xs"
          >
            {isPending ? t.weldchat.dmCreate.creating : t.weldchat.dmCreate.startConversation}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
