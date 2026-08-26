import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Send } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@weldsuite/ui/components/button';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { useReplyToDeskConversation } from '@/hooks/queries/use-desk-queries';

type ComposerTab = 'reply' | 'note';

interface ComposerProps {
  conversationId: string;
}

export function Composer({ conversationId }: ComposerProps) {
  const t = getTranslations('deskInbox2');
  const [tab, setTab] = useState<ComposerTab>('reply');
  const [body, setBody] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const reply = useReplyToDeskConversation();
  const isSending = reply.isPending;

  const handleSend = async () => {
    const trimmed = body.trim();
    if (!trimmed || isSending) return;
    try {
      await reply.mutateAsync({
        id: conversationId,
        data: { kind: tab === 'note' ? 'note' : 'message', body: trimmed },
      });
      toast.success(tab === 'note' ? t.composer.noteSuccess : t.composer.replySuccess);
      setBody('');
    } catch {
      toast.error(t.composer.replyError);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleSend();
    }
  };

  useEffect(() => {
    setBody('');
    setTab('reply');
  }, [conversationId]);

  return (
    <div className="border-t p-3 flex flex-col gap-2" data-testid="desk-inbox-composer">
      <Tabs value={tab} onValueChange={(v) => setTab(v as ComposerTab)}>
        <TabsList>
          <TabsTrigger value="reply">{t.composer.replyTab}</TabsTrigger>
          <TabsTrigger value="note">{t.composer.noteTab}</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className={cn('relative rounded-md', tab === 'note' && 'bg-amber-50 dark:bg-amber-950/30 -m-1 p-1')}>
        <Textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={tab === 'note' ? t.composer.notePlaceholder : t.composer.replyPlaceholder}
          className="min-h-[88px] resize-none bg-transparent"
          data-testid="desk-inbox-composer-textarea"
        />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{t.composer.sendHint}</span>
        <Button
          type="button"
          size="sm"
          onClick={() => void handleSend()}
          disabled={!body.trim() || isSending}
          data-testid="desk-inbox-composer-send"
        >
          {isSending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1.5" />}
          {tab === 'note' ? t.composer.addNote : t.composer.sendReply}
        </Button>
      </div>
    </div>
  );
}
