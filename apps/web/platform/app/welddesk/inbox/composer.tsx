import { useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@weldsuite/ui/components/button';

type ComposerTab = 'reply' | 'note';

interface ComposerProps {
  conversationId: string;
  onSend: (kind: 'message' | 'note', body: string) => void;
  onTyping?: () => void;
  onStopTyping?: () => void;
}

const MAX_HEIGHT_PX = 240;

export function Composer({ conversationId, onSend, onTyping, onStopTyping }: Readonly<ComposerProps>) {
  const t = getTranslations('deskInbox2');
  const [tab, setTab] = useState<ComposerTab>('reply');
  const [body, setBody] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Grow with the text, up to a cap.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [body]);

  useEffect(() => {
    setBody('');
    setTab('reply');
    textareaRef.current?.focus();
  }, [conversationId]);

  const handleSend = () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    // The message appears in the thread right away (optimistic), so the box
    // clears immediately and the agent can keep typing.
    onSend(tab === 'note' ? 'note' : 'message', trimmed);
    setBody('');
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    handleSend();
  };

  const handleChange = (value: string) => {
    setBody(value);
    // Visitors only see typing for replies — never for internal notes.
    if (tab !== 'reply') return;
    if (value.trim()) onTyping?.();
    else onStopTyping?.();
  };

  const switchTab = (next: ComposerTab) => {
    setTab(next);
    if (next === 'note') onStopTyping?.();
    textareaRef.current?.focus();
  };

  return (
    <div className="flex-shrink-0 px-3 md:px-4 pb-3 pt-2 bg-white dark:bg-background" data-testid="desk-inbox-composer">
      <div
        className={cn(
          'rounded-xl border border-gray-200 dark:border-border overflow-hidden transition-colors focus-within:border-gray-300 dark:focus-within:border-muted-foreground/40',
          tab === 'note' && 'border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/20',
        )}
      >
        <div className="flex items-center gap-1 px-2 pt-2">
          {(['reply', 'note'] as const).map((value) => (
            <Button
              key={value}
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                'h-7 px-2.5 text-xs',
                tab === value ? 'bg-muted text-foreground' : 'text-muted-foreground',
              )}
              onClick={() => switchTab(value)}
            >
              {value === 'reply' ? t.composer.replyTab : t.composer.noteTab}
            </Button>
          ))}
        </div>
        <textarea
          ref={textareaRef}
          value={body}
          rows={2}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => onStopTyping?.()}
          placeholder={tab === 'note' ? t.composer.notePlaceholder : t.composer.replyPlaceholder}
          className="w-full min-h-[64px] resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/70"
          data-testid="desk-inbox-composer-textarea"
        />
        <div className="flex items-center justify-between px-3 py-2 border-t border-border/50">
          <span className="text-xs text-muted-foreground">{t.composer.sendHint}</span>
          <Button
            type="button"
            size="sm"
            onClick={handleSend}
            disabled={!body.trim()}
            data-testid="desk-inbox-composer-send"
          >
            <Send className="h-3.5 w-3.5 mr-1.5" />
            {tab === 'note' ? t.composer.addNote : t.composer.sendReply}
          </Button>
        </div>
      </div>
    </div>
  );
}
