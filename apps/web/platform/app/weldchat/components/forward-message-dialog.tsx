import { useState, useMemo, useRef, useEffect } from 'react';
import { Hash, Lock, X, User, Users, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import {
  Popover,
  PopoverContent,
  PopoverAnchor,
} from '@weldsuite/ui/components/popover';
import { useChannels, useCreateDm, useForwardMessage } from '@/hooks/queries/use-weldchat-queries';
import { useWorkspaceMembers } from '@/hooks/queries/use-settings-queries';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { renderMessageContent } from '../lib/render-message-content';

/** A channel, group, DM, or user picked as a forward target. */
interface ForwardTarget {
  id: string;
  rawId: string;
  name: string;
  kind: 'private' | 'group' | 'channel' | 'user';
}

const TARGET_KIND_ICONS: Record<ForwardTarget['kind'], LucideIcon> = {
  user: User,
  group: Users,
  private: Lock,
  channel: Hash,
};

function TargetKindIcon({ kind, className }: Readonly<{ kind: ForwardTarget['kind']; className: string }>) {
  const Icon = TARGET_KIND_ICONS[kind];
  return <Icon className={className} />;
}

interface RawChannelOption {
  id: string;
  name?: string;
  isPrivate?: boolean;
  type?: string;
}

interface RawMemberOption {
  id?: string;
  userId?: string;
  name?: string;
  email?: string;
}

function getChannelKind(ch: RawChannelOption): 'private' | 'group' | 'channel' {
  if (ch.isPrivate || ch.type === 'private') return 'private';
  if (ch.type === 'group') return 'group';
  return 'channel';
}

interface ForwardMessageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messageContent: string;
  originalAuthor: string;
  messageId?: string;
  sourceChannelId?: string;
}

export function ForwardMessageDialog({
  open,
  onOpenChange,
  messageContent,
  originalAuthor,
  messageId,
  sourceChannelId,
}: Readonly<ForwardMessageDialogProps>) {
  const { t } = useI18n();
  const st = useTranslations();
  const [query, setQuery] = useState('');
  const [selectedList, setSelectedList] = useState<ForwardTarget[]>([]);
  const [extraMessage, setExtraMessage] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const { data: channelsData } = useChannels();
  const { data: membersData } = useWorkspaceMembers();
  const { mutateAsync: forwardMessage, isPending } = useForwardMessage();
  const { mutateAsync: createDm } = useCreateDm();
  const inputRef = useRef<HTMLInputElement>(null);

  const channels = useMemo(
    () => (channelsData?.data ?? []) as RawChannelOption[],
    [channelsData],
  );
  const members = useMemo(
    () => (membersData?.data ?? []) as RawMemberOption[],
    [membersData],
  );

  // userId → name, so mentions in the quoted message render as chips.
  const memberNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) {
      if (m.userId && m.name) map.set(m.userId, m.name);
    }
    return map;
  }, [members]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const selectedIds = new Set(selectedList.map((s) => s.id));

    const channelItems = channels
      .filter((ch) => (q ? (ch.name || '').toLowerCase().includes(q) : true))
      .map((ch) => ({
        id: `channel:${ch.id}`,
        rawId: ch.id,
        name: ch.name ?? '',
        kind: getChannelKind(ch),
      }));

    const userItems = members
      .filter((m) => {
        const name = (m.name || m.email || '').toLowerCase();
        return q ? name.includes(q) : true;
      })
      .map((m) => ({
        id: `user:${m.userId || m.id}`,
        rawId: m.userId || m.id || '',
        name: m.name || m.email || '',
        kind: 'user' as const,
      }));

    return [...channelItems, ...userItems]
      .filter((it) => !selectedIds.has(it.id))
      .slice(0, 30);
  }, [channels, members, query, selectedList]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedList([]);
      setExtraMessage('');
      setShowDropdown(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const handleSelect = (ch: ForwardTarget) => {
    setSelectedList((prev) =>
      prev.some((s) => s.id === ch.id) ? prev : [...prev, ch],
    );
    setQuery('');
    setShowDropdown(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleRemove = (id: string) => {
    setSelectedList((prev) => prev.filter((s) => s.id !== id));
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const canForward = selectedList.length > 0 && !isPending && !!messageId && !!sourceChannelId;

  // Resolve each selected target to a channelId we can post into. For users, create/find a DM.
  const resolveChannelIds = async () => {
    const resolved = await Promise.all(
      selectedList.map(async (target): Promise<string | undefined> => {
        if (target.kind !== 'user') return target.rawId;
        try {
          const dm = await createDm({ userIds: [target.rawId] });
          return dm?.data?.id;
        } catch {
          toast.error(st('sweep.weldchat.forwardMessage.couldNotOpenDm', { name: target.name }));
          return undefined;
        }
      }),
    );
    return resolved.filter((id): id is string => !!id);
  };

  const handleForward = async () => {
    if (selectedList.length === 0 || !messageId || !sourceChannelId) return;
    const targetChannelIds = await resolveChannelIds();
    if (targetChannelIds.length === 0) {
      toast.error(t.weldchat.forwardMessage.noValidRecipients);
      return;
    }
    try {
      await forwardMessage({
        sourceChannelId,
        sourceMessageId: messageId,
        targetChannelIds,
        comment: extraMessage.trim() || undefined,
      });
      toast.success(
        selectedList.length === 1
          ? t.weldchat.forwardMessage.forwardedTo.replace('{name}', selectedList[0].name)
          : t.weldchat.forwardMessage.forwardedToMultiple.replace('{count}', String(selectedList.length)),
      );
      onOpenChange(false);
    } catch (e) {
      const message = e instanceof Error ? e.message : undefined;
      toast.error(message || t.weldchat.forwardMessage.failedToForward);
    }
  };

  const handleCopyLink = () => {
    if (!messageId || !sourceChannelId) {
      toast.error(t.weldchat.forwardMessage.linkUnavailable);
      return;
    }
    const url = `${window.location.origin}/weldchat/${sourceChannelId}?msg=${messageId}`;
    navigator.clipboard.writeText(url).then(
      () => toast.success(t.weldchat.forwardMessage.messageLinkCopied),
      () => toast.error(t.sweep.entities.copyLinkFailed),
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg p-0 gap-0 overflow-hidden" showCloseButton={false}>
        {/* Header */}
        <DialogHeader className="flex flex-row items-center justify-between px-5 py-4">
          <DialogTitle className="text-base font-semibold">{t.weldchat.forwardMessage.title}</DialogTitle>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 -mr-1"
            onClick={() => onOpenChange(false)}
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </Button>
        </DialogHeader>

        <div className="px-5 pb-4 space-y-3">
          {/* Recipient picker (multi-select) */}
          <Popover
            open={showDropdown && matches.length > 0}
            onOpenChange={(o) => {
              if (!o) setShowDropdown(false);
            }}
          >
            <PopoverAnchor asChild>
              <div
                role="presentation"
                className={cn(
                  "flex flex-wrap items-center gap-1.5 min-h-9 rounded-md border border-input bg-transparent dark:bg-input/30 px-2 py-1 text-sm transition-[color,box-shadow]",
                  "focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]"
                )}
                onClick={() => inputRef.current?.focus()}
              >
                {selectedList.map((t) => (
                  <span
                    key={t.id}
                    className="inline-flex items-center gap-1 rounded bg-accent text-accent-foreground px-1.5 py-[4px] text-xs font-medium"
                  >
                    <TargetKindIcon kind={t.kind} className="h-3 w-3" />
                    {t.name}
                    <Button
                      variant="ghost"
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        handleRemove(t.id);
                      }}
                      className="ml-0.5 rounded hover:text-foreground"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </span>
                ))}
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setShowDropdown(true);
                  }}
                  onFocus={() => setShowDropdown(true)}
                  onKeyDown={(e) => {
                    if (e.key === 'Backspace' && query === '' && selectedList.length > 0) {
                      e.preventDefault();
                      setSelectedList((prev) => prev.slice(0, -1));
                    }
                  }}
                  placeholder={selectedList.length === 0 ? t.weldchat.forwardMessage.recipientPlaceholder : ''}
                  className="flex-1 min-w-[120px] bg-transparent outline-none placeholder:text-muted-foreground text-sm"
                />
              </div>
            </PopoverAnchor>
            <PopoverContent
              align="start"
              sideOffset={4}
              onOpenAutoFocus={(e) => e.preventDefault()}
              onCloseAutoFocus={(e) => e.preventDefault()}
              onInteractOutside={(e) => {
                // Keep the menu open if the user is still interacting with the picker input/chips
                const target = e.target as Node | null;
                if (target && inputRef.current?.parentElement?.contains(target)) {
                  e.preventDefault();
                }
              }}
              style={{ maxHeight: 288, overflowY: 'auto' }}
              onWheel={(e) => {
                // Dialog's pointer-events/scroll-lock swallows the native wheel on
                // portaled popovers — scroll the content manually so the mouse wheel works.
                e.currentTarget.scrollTop += e.deltaY;
              }}
              className="w-[var(--radix-popover-trigger-width)] overscroll-contain p-1"
            >
              {matches.map((it) => (
                <Button
                  variant="ghost"
                  key={it.id}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleSelect(it);
                  }}
                  className="w-full flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-left outline-hidden hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
                >
                  <TargetKindIcon kind={it.kind} className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>{it.name}</span>
                </Button>
              ))}
            </PopoverContent>
          </Popover>

          {/* Message textarea */}
          <div className="rounded-md border border-input bg-transparent dark:bg-input/30 transition-[color,box-shadow] focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]">
            <Textarea
              value={extraMessage}
              onChange={(e) => setExtraMessage(e.target.value)}
              placeholder={t.weldchat.forwardMessage.messagePlaceholder}
              rows={2}
              className="resize-none min-h-[48px] border-0 bg-transparent dark:bg-transparent focus-visible:ring-0 focus-visible:border-0 shadow-none"
            />
          </div>

          {/* Original message preview */}
          <div className="rounded-md border bg-muted/30 px-2.5">
            <div className="flex items-start gap-2.5 py-2.5">
              <Avatar className="h-7 w-7 flex-shrink-0 !rounded-[6px]">
                <AvatarFallback className="text-xs !rounded-[6px] bg-primary/10 text-primary font-semibold">
                  {(originalAuthor || '?')[0].toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1 leading-snug">
                <div className="text-sm font-semibold text-foreground">{originalAuthor}</div>
                <div className="text-sm text-foreground/80 break-words whitespace-pre-wrap line-clamp-4 mt-0.5">
                  {renderMessageContent(messageContent, memberNames)}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3">
          <Button variant="outline" onClick={handleCopyLink} disabled={!messageId}>
            {t.weldchat.forwardMessage.copyLink}
          </Button>
          {/* No "Schedule" here: nothing persists a scheduled forward server-side,
              and a browser timer silently drops it on reload. */}
          <Button disabled={!canForward} onClick={handleForward}>
            {t.weldchat.forwardMessage.forward}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
