import { useState, useMemo, useRef, useEffect } from 'react';
import { Search, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { useCreateChannel, useWorkspaceMembers } from '@/hooks/queries/use-weldchat-queries';
import { useNavigate } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';

interface ChannelCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChannelCreateDialog({
  open,
  onOpenChange,
}: ChannelCreateDialogProps) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [memberSearch, setMemberSearch] = useState('');
  const [showMemberDropdown, setShowMemberDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // Close dropdown on outside click
  useEffect(() => {
    if (!showMemberDropdown) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowMemberDropdown(false);
      }
    };
    document.addEventListener('pointerdown', handler, true);
    return () => document.removeEventListener('pointerdown', handler, true);
  }, [showMemberDropdown]);
  const { mutate: createChannel, isPending } = useCreateChannel();
  const { data: membersData } = useWorkspaceMembers();

  const members: any[] = membersData?.data ?? [];

  const filteredMembers = useMemo(() => {
    if (!memberSearch) return members;
    const q = memberSearch.toLowerCase();
    return members.filter(
      (m: any) =>
        m.name?.toLowerCase().includes(q) ||
        m.email?.toLowerCase().includes(q),
    );
  }, [members, memberSearch]);

  const selectedMembersList = members.filter((m: any) =>
    selectedMembers.includes(m.userId),
  );

  const toggleMember = (userId: string) => {
    setSelectedMembers((prev) =>
      prev.includes(userId)
        ? prev.filter((id) => id !== userId)
        : [...prev, userId],
    );
  };

  const reset = () => {
    setName('');
    setIsPrivate(false);
    setSelectedMembers([]);
    setMemberSearch('');
    setShowMemberDropdown(false);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createChannel(
      {
        name: name.trim(),
        type: isPrivate ? 'private' : 'public',
        memberIds: isPrivate && selectedMembers.length > 0 ? selectedMembers : undefined,
      },
      {
        onSuccess: (data: any) => {
          onOpenChange(false);
          reset();
          if (data?.data?.id)
            navigate({
              to: '/weldchat/$channelId',
              params: { channelId: data.data.id },
            });
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{t.weldchat.channelCreate.title}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="channel-name">{t.weldchat.channelCreate.nameLabel}</Label>
            <Input
              id="channel-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.weldchat.channelCreate.namePlaceholder}
              autoFocus
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="channel-private">{t.weldchat.channelCreate.makePrivate}</Label>
              <p className="text-xs text-muted-foreground mt-1">
                {t.weldchat.channelCreate.makePrivateHint}
              </p>
            </div>
            <Switch
              id="channel-private"
              checked={isPrivate}
              onCheckedChange={setIsPrivate}
              className="w-8 h-[18px]"
            />
          </div>
          {isPrivate && (
            <div className="space-y-2">
              <Label>{t.weldchat.channelCreate.addMembers}</Label>
              {/* Selected members */}
              {selectedMembersList.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {selectedMembersList.map((m: any) => (
                    <div
                      key={m.userId}
                      className="flex items-center gap-1 bg-muted rounded-md px-2 py-1 text-sm"
                    >
                      <Avatar className="h-4 w-4 !rounded-[4px]">
                        {m.picture && <AvatarImage src={m.picture} className="!rounded-[4px]" />}
                        <AvatarFallback className="text-[8px] !rounded-[4px]">
                          {(m.name || m.email || '?')[0].toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <span className="truncate max-w-[100px]">{m.name || m.email}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => toggleMember(m.userId)}
                        className="text-muted-foreground hover:text-foreground ml-0.5 p-0 h-auto w-auto"
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              {/* Search with dropdown */}
              <div className="relative" ref={dropdownRef}>
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    value={memberSearch}
                    onChange={(e) => setMemberSearch(e.target.value)}
                    placeholder={t.weldchat.channelCreate.searchMembers}
                    className="h-8 pl-7 text-sm"
                    onFocus={() => setShowMemberDropdown(true)}
                  />
                </div>
                {showMemberDropdown && (
                  <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded-md border bg-popover shadow-md">
                    <ScrollArea className="max-h-[200px]">
                      <div className="p-1">
                        {filteredMembers.map((m: any) => {
                          const isSelected = selectedMembers.includes(m.userId);
                          return (
                            <Button
                              key={m.userId}
                              type="button"
                              variant="ghost"
                              onClick={() => {
                                toggleMember(m.userId);
                                setMemberSearch('');
                              }}
                              className={cn(
                                'w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md text-left text-sm transition-colors',
                                isSelected
                                  ? 'bg-primary/10 text-primary'
                                  : 'hover:bg-accent',
                              )}
                            >
                              <Avatar className="h-6 w-6 !rounded-[6px]">
                                {m.picture && <AvatarImage src={m.picture} className="!rounded-[6px]" />}
                                <AvatarFallback className="text-[9px] !rounded-[6px]">
                                  {(m.name || m.email || '?')[0].toUpperCase()}
                                </AvatarFallback>
                              </Avatar>
                              <span className="flex-1 truncate">{m.name || m.email}</span>
                              {isSelected && (
                                <div className="h-4 w-4 rounded-full bg-primary flex items-center justify-center flex-shrink-0">
                                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-2.5 w-2.5 text-primary-foreground">
                                    <path d="M20 6 9 17l-5-5" />
                                  </svg>
                                </div>
                              )}
                            </Button>
                          );
                        })}
                        {filteredMembers.length === 0 && (
                          <p className="text-sm text-muted-foreground text-center py-3">{t.weldchat.channelCreate.noMembersFound}</p>
                        )}
                      </div>
                    </ScrollArea>
                  </div>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t.weldchat.channelCreate.cancel}
            </Button>
            <Button type="submit" disabled={!name.trim() || isPending} data-testid="channel-create-submit">
              {isPending ? t.weldchat.channelCreate.creating : t.weldchat.channelCreate.create}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
