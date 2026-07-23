import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Send, Zap } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@weldsuite/ui/components/button';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import {
  Popover,
  PopoverContent,
  PopoverAnchor,
} from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import {
  useApplyDeskMacro,
  useDeskMacros,
  useReplyToDeskConversation,
} from '@/hooks/queries/use-desk-queries';
import { useDeskWorkspaceMembers, type DeskWorkspaceMember } from '@/hooks/queries/use-desk-workspace-members';

type ComposerTab = 'reply' | 'note';

interface ComposerProps {
  conversationId: string;
}

/** Extracts `@Name ` tokens that match a known member into mentionUserIds. */
function extractMentions(body: string, members: DeskWorkspaceMember[]): string[] {
  const ids = new Set<string>();
  for (const member of members) {
    if (member.name && body.includes(`@${member.name}`)) {
      ids.add(member.userId);
    }
  }
  return Array.from(ids);
}

export function Composer({ conversationId }: ComposerProps) {
  const t = getTranslations('deskInbox2');
  const [tab, setTab] = useState<ComposerTab>('reply');
  const [body, setBody] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [macroOpen, setMacroOpen] = useState(false);
  const [macroQuery, setMacroQuery] = useState('');

  const reply = useReplyToDeskConversation();
  const applyMacro = useApplyDeskMacro();
  const { data: membersData } = useDeskWorkspaceMembers();
  const members = membersData ?? [];
  const { data: macrosData } = useDeskMacros();
  const macros = macrosData?.data ?? [];

  const filteredMembers = useMemo(() => {
    const q = mentionQuery.trim().toLowerCase();
    if (!q) return members.slice(0, 8);
    return members.filter((m) => m.name.toLowerCase().includes(q)).slice(0, 8);
  }, [members, mentionQuery]);

  const filteredMacros = useMemo(() => {
    const q = macroQuery.trim().toLowerCase();
    if (!q) return macros.slice(0, 8);
    return macros.filter((m) => m.name.toLowerCase().includes(q)).slice(0, 8);
  }, [macros, macroQuery]);

  const isSending = reply.isPending;

  const handleBodyChange = (value: string) => {
    setBody(value);

    // Detect trailing "@query" or "#query" tokens right before the caret to
    // drive the mention / macro popovers. Simple heuristic (no full parser):
    // look at the text up to the caret, find the last @ or # not preceded by
    // a non-space char.
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? value.length;
    const upToCaret = value.slice(0, caret);

    const atMatch = /(?:^|\s)@([^\s@]*)$/.exec(upToCaret);
    if (tab === 'note' && atMatch) {
      setMentionQuery(atMatch[1] ?? '');
      setMentionOpen(true);
    } else {
      setMentionOpen(false);
    }

    const hashMatch = /(?:^|\s)#([^\s#]*)$/.exec(upToCaret);
    if (hashMatch) {
      setMacroQuery(hashMatch[1] ?? '');
      setMacroOpen(true);
    } else {
      setMacroOpen(false);
    }
  };

  const insertMention = (member: DeskWorkspaceMember) => {
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? body.length;
    const upToCaret = body.slice(0, caret);
    const replaced = upToCaret.replace(/(?:^|\s)@([^\s@]*)$/, (m) => `${m[0] === '@' ? '' : m[0]}@${member.name} `);
    const next = replaced + body.slice(caret);
    setBody(next);
    setMentionOpen(false);
    requestAnimationFrame(() => el?.focus());
  };

  const applyMacroSelection = async (macroId: string) => {
    setMacroOpen(false);
    // Strip the trailing "#query" token that triggered the picker.
    setBody((prev) => prev.replace(/(?:^|\s)#([^\s#]*)$/, (m) => (m[0] === '#' ? '' : m[0])));
    try {
      const result = await applyMacro.mutateAsync({ id: conversationId, macroId });
      const prefill = result.data.composerPrefill;
      if (prefill) {
        const macro = macros.find((m) => m.id === macroId);
        setTab(macro?.insertAs ?? 'reply');
        setBody(prefill);
      }
      toast.success(t.composer.macroApplied);
    } catch {
      toast.error(t.composer.macroApplyError);
    }
  };

  const handleSend = async () => {
    const trimmed = body.trim();
    if (!trimmed || isSending) return;

    try {
      if (tab === 'note') {
        await reply.mutateAsync({
          id: conversationId,
          data: {
            messageType: 'note',
            body: trimmed,
            mentionUserIds: extractMentions(trimmed, members),
          },
        });
        toast.success(t.composer.noteSuccess);
      } else {
        await reply.mutateAsync({
          id: conversationId,
          data: { messageType: 'comment', body: trimmed },
        });
        toast.success(t.composer.replySuccess);
      }
      setBody('');
    } catch {
      toast.error(t.composer.replyError);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSend();
      return;
    }
    if (e.key === 'Escape') {
      setMentionOpen(false);
      setMacroOpen(false);
    }
  };

  // Reset composer state when the conversation changes.
  useEffect(() => {
    setBody('');
    setTab('reply');
    setMentionOpen(false);
    setMacroOpen(false);
  }, [conversationId]);

  return (
    <div className="border-t p-3 flex flex-col gap-2" data-testid="desk-inbox2-composer">
      <div className="flex items-center justify-between">
        <Tabs value={tab} onValueChange={(v) => setTab(v as ComposerTab)}>
          <TabsList>
            <TabsTrigger value="reply">{t.composer.replyTab}</TabsTrigger>
            <TabsTrigger value="note">{t.composer.noteTab}</TabsTrigger>
          </TabsList>
        </Tabs>
        <Popover open={macroOpen && !mentionOpen} onOpenChange={setMacroOpen}>
          <PopoverAnchor asChild>
            <span />
          </PopoverAnchor>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t.composer.macros}
            onClick={() => setMacroOpen((v) => !v)}
          >
            <Zap className="h-4 w-4" />
          </Button>
        </Popover>
      </div>

      <div className={cn('relative rounded-md', tab === 'note' && 'bg-amber-50 dark:bg-amber-950/30 -m-1 p-1')}>
        <Popover open={mentionOpen} onOpenChange={setMentionOpen}>
          <PopoverAnchor asChild>
            <Textarea
              ref={textareaRef}
              value={body}
              onChange={(e) => handleBodyChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={tab === 'note' ? t.composer.notePlaceholder : t.composer.replyPlaceholder}
              className="min-h-[88px] resize-none bg-transparent"
              data-testid="desk-inbox2-composer-textarea"
            />
          </PopoverAnchor>
          <PopoverContent align="start" className="w-64 p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
            <Command shouldFilter={false}>
              <CommandList className="max-h-48">
                <CommandEmpty>{t.composer.mentionsEmpty}</CommandEmpty>
                {filteredMembers.map((member) => (
                  <CommandItem key={member.userId} value={member.userId} onSelect={() => insertMention(member)}>
                    <Avatar className="h-5 w-5">
                      {member.picture && <AvatarImage src={member.picture} />}
                      <AvatarFallback className="text-[10px]">{member.name.slice(0, 1).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <span className="truncate">{member.name}</span>
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        <Popover open={macroOpen} onOpenChange={setMacroOpen}>
          <PopoverAnchor asChild>
            <span className="absolute bottom-0 left-0" />
          </PopoverAnchor>
          <PopoverContent align="start" className="w-72 p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
            <Command shouldFilter={false}>
              <CommandInput
                placeholder={t.composer.macrosSearchPlaceholder}
                value={macroQuery}
                onValueChange={setMacroQuery}
              />
              <CommandList className="max-h-56">
                <CommandEmpty>{t.composer.macrosEmpty}</CommandEmpty>
                {filteredMacros.map((macro) => (
                  <CommandItem key={macro.id} value={macro.name} onSelect={() => applyMacroSelection(macro.id)}>
                    <span className="truncate">{macro.name}</span>
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{t.composer.sendHint}</span>
        <Button
          type="button"
          size="sm"
          onClick={handleSend}
          disabled={!body.trim() || isSending}
          data-testid="desk-inbox2-composer-send"
        >
          {isSending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1.5" />}
          {tab === 'note' ? t.composer.addNote : t.composer.sendReply}
        </Button>
      </div>
    </div>
  );
}
