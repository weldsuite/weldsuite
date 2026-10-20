import { cn } from '@/lib/utils';
import { Button } from '@weldsuite/ui/components/button';
import { useAuth } from '@clerk/clerk-react';
import { useToggleReaction } from '@/hooks/queries/use-weldchat-queries';

interface ReactionBarProps {
  reactions: Record<string, string[]>;
  messageId: string;
  channelId: string;
}

export function ReactionBar({
  reactions,
  messageId,
  channelId,
}: Readonly<ReactionBarProps>) {
  const { userId } = useAuth();
  const { mutate: toggleReaction } = useToggleReaction();

  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {Object.entries(reactions).map(([emoji, userIds]) => {
        const hasReacted = userId ? userIds.includes(userId) : false;
        return (
          <Button
            key={emoji}
            variant="ghost"
            data-testid="chat-reaction"
            onClick={() => {
              toggleReaction({ messageId, channelId, emoji, hasReacted });
              requestAnimationFrame(() =>
                window.dispatchEvent(new Event('weldchat-focus-input')),
              );
            }}
            className={cn(
              // `h-6` overrides the Button's default `h-9`, which made the pill
              // 36px tall and pushed the next message down.
              'inline-flex items-center gap-1 h-6 px-1.5 py-0 rounded-md text-xs leading-none border transition-colors',
              hasReacted
                ? 'bg-blue-600/10 border-blue-600/40 hover:bg-blue-600/20 dark:hover:bg-blue-600/20'
                : 'bg-muted/40 border-border hover:bg-muted dark:hover:bg-muted',
            )}
          >
            <span>{emoji}</span>
            <span className={cn('font-mono tabular-nums', hasReacted ? 'text-blue-600' : 'text-muted-foreground')}>{userIds.length}</span>
          </Button>
        );
      })}
    </div>
  );
}
