import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Send } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@weldsuite/ui/components/button';
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
    <div className="flex-shrink-0 px-3 md:px-4 pb-3 pt-1 bg-white dark:bg-background" data-testid="desk-inbox-composer">
      <div
        className={cn(
          'rounded-lg border border-gray-200 dark:border-border overflow-hidden',
          tab === 'note' && 'border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/20',
        )}
      >
        <div className="flex items-center gap-1 px-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              'h-7 px-2.5 text-xs',
              tab === 'reply' ? 'bg-muted text-foreground' : 'text-muted-foreground',
            )}
            onClick={() => setTab('reply')}
          >
            {t.composer.replyTab}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              'h-7 px-2.5 text-xs',
              tab === 'note' ? 'bg-muted text-foreground' : 'text-muted-foreground',
            )}
            onClick={() => setTab('note')}
          >
            {t.composer.noteTab}
          </Button>
        </div>
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={tab === 'note' ? t.composer.notePlaceholder : t.composer.replyPlaceholder}
          className="w-full min-h-[88px] resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/70"
          data-testid="desk-inbox-composer-textarea"
        />
        <div className="flex items-center justify-between px-3 py-2 border-t border-border/50">
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
    </div>
  );
}
