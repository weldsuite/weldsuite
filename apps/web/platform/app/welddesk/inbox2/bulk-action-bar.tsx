import { useState } from 'react';
import { toast } from 'sonner';
import { CheckSquare, Loader2, Tag as TagIcon, Users, X } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { Button } from '@weldsuite/ui/components/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import {
  useAddDeskConversationTag,
  useManageDeskConversation,
} from '@/hooks/queries/use-desk-queries';
import { useDeskWorkspaceMembers } from '@/hooks/queries/use-desk-workspace-members';

interface BulkActionBarProps {
  selectedIds: string[];
  onClear: () => void;
}

/**
 * Light "table mode" bulk action bar — Assign / Close / Add tag over the
 * current selection, firing the manage/tags mutations sequentially. A real
 * table layout (sortable columns, row density) is explicitly deferred; see
 * bulk.tableLayoutDeferred copy + the Phase 2 task's own note.
 */
export function BulkActionBar({ selectedIds, onClear }: BulkActionBarProps) {
  const t = getTranslations('deskInbox2');
  const manage = useManageDeskConversation();
  const addTag = useAddDeskConversationTag();
  const { data: membersData } = useDeskWorkspaceMembers();
  const members = membersData ?? [];

  const [assignOpen, setAssignOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const [tagQuery, setTagQuery] = useState('');
  const [pending, setPending] = useState(false);

  if (selectedIds.length === 0) return null;

  const runSequentially = async (fn: (id: string) => Promise<unknown>) => {
    setPending(true);
    let failures = 0;
    for (const id of selectedIds) {
      try {
        await fn(id);
      } catch {
        failures += 1;
      }
    }
    setPending(false);
    return failures;
  };

  const handleAssign = async (userId: string) => {
    setAssignOpen(false);
    const failures = await runSequentially((id) =>
      manage.mutateAsync({ id, data: { action: 'assign', assigneeType: 'admin', assigneeId: userId } }),
    );
    if (failures > 0) toast.error(t.bulk.actionError);
    else toast.success(t.bulk.assignSuccess.replace('{count}', String(selectedIds.length)));
    onClear();
  };

  const handleClose = async () => {
    const failures = await runSequentially((id) => manage.mutateAsync({ id, data: { action: 'close' } }));
    if (failures > 0) toast.error(t.bulk.actionError);
    else toast.success(t.bulk.closeSuccess.replace('{count}', String(selectedIds.length)));
    onClear();
  };

  const handleAddTag = async (tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed) return;
    setTagOpen(false);
    setTagQuery('');
    const failures = await runSequentially((id) => addTag.mutateAsync({ id, tag: trimmed }));
    if (failures > 0) toast.error(t.bulk.actionError);
    else toast.success(t.bulk.tagSuccess.replace('{count}', String(selectedIds.length)));
    onClear();
  };

  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b bg-accent/50" data-testid="desk-inbox2-bulk-bar">
      <span className="text-xs font-medium">{t.bulk.selected.replace('{count}', String(selectedIds.length))}</span>
      <div className="flex items-center gap-1.5 ml-auto">
        {pending && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        <Popover open={assignOpen} onOpenChange={setAssignOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-7 gap-1.5" disabled={pending}>
              <Users className="h-3.5 w-3.5" />
              {t.bulk.assign}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 p-0">
            <Command>
              <CommandInput placeholder={t.header.assignSearchPlaceholder} />
              <CommandList className="max-h-56">
                <CommandGroup>
                  {members.map((member) => (
                    <CommandItem key={member.userId} value={member.name} onSelect={() => handleAssign(member.userId)}>
                      <Avatar className="h-5 w-5">
                        {member.picture && <AvatarImage src={member.picture} />}
                        <AvatarFallback className="text-[10px]">{member.name.slice(0, 1).toUpperCase()}</AvatarFallback>
                      </Avatar>
                      <span className="truncate">{member.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        <Button variant="outline" size="sm" className="h-7 gap-1.5" disabled={pending} onClick={handleClose}>
          <CheckSquare className="h-3.5 w-3.5" />
          {t.bulk.close}
        </Button>

        <Popover open={tagOpen} onOpenChange={setTagOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-7 gap-1.5" disabled={pending}>
              <TagIcon className="h-3.5 w-3.5" />
              {t.bulk.addTag}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 p-2">
            <div className="flex gap-1.5">
              <input
                value={tagQuery}
                onChange={(e) => setTagQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddTag(tagQuery);
                }}
                placeholder={t.header.addTag}
                className="flex-1 h-8 rounded-md border bg-transparent px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <Button size="sm" className="h-8" onClick={() => handleAddTag(tagQuery)}>
                {t.header.addTag}
              </Button>
            </div>
          </PopoverContent>
        </Popover>

        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClear} aria-label={t.bulk.clearSelection}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
