import { useState, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { Check } from 'lucide-react';
import {
  useCreateDm,
  useWorkspaceMembers,
} from '@/hooks/queries/use-weldchat-queries';
import { useNavigate } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';

interface DmCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DmCreateDialog({ open, onOpenChange }: DmCreateDialogProps) {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const navigate = useNavigate();
  const { data: membersData } = useWorkspaceMembers();
  const { mutate: createDm, isPending } = useCreateDm();

  const members = membersData?.data || [];
  const filtered = useMemo(() => {
    if (!search) return members;
    const q = search.toLowerCase();
    return members.filter(
      (m: any) =>
        m.name?.toLowerCase().includes(q) || m.email?.toLowerCase().includes(q)
    );
  }, [members, search]);

  const toggleMember = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handleCreate = () => {
    if (selectedIds.length === 0) return;

    // 1:1 DM — just navigate to the user, channel auto-resolves
    if (selectedIds.length === 1) {
      onOpenChange(false);
      setSearch('');
      setSelectedIds([]);
      navigate({
        to: '/weldchat/dm/$userId',
        params: { userId: selectedIds[0] },
      });
      return;
    }

    // Group DM (3+ participants) — use POST /chat/dm
    createDm(
      { userIds: selectedIds },
      {
        onSuccess: (data: any) => {
          onOpenChange(false);
          setSearch('');
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{t.weldchat.dmCreate.title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.weldchat.dmCreate.searchPeople}
            autoFocus
          />
          <ScrollArea className="h-[300px]">
            <div className="space-y-0.5">
              {filtered.map((member: any) => (
                <Button
                  key={member.userId || member.id}
                  variant="ghost"
                  onClick={() => toggleMember(member.userId || member.id)}
                  className={cn(
                    'flex items-center gap-3 w-full px-3 py-2 rounded-md hover:bg-muted text-left',
                    selectedIds.includes(member.userId || member.id) &&
                      'bg-muted'
                  )}
                >
                  <Avatar className="h-8 w-8">
                    <AvatarFallback className="text-xs">
                      {(member.name || member.email || '?')[0].toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {member.name || member.email}
                    </p>
                    {member.name && member.email && (
                      <p className="text-xs text-muted-foreground truncate">
                        {member.email}
                      </p>
                    )}
                  </div>
                  {selectedIds.includes(member.userId || member.id) && (
                    <Check className="h-4 w-4 text-primary flex-shrink-0" />
                  )}
                </Button>
              ))}
            </div>
          </ScrollArea>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t.weldchat.dmCreate.cancel}
          </Button>
          <Button
            onClick={handleCreate}
            disabled={selectedIds.length === 0 || isPending}
          >
            {isPending ? t.weldchat.dmCreate.creating : t.weldchat.dmCreate.startConversation}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
