import { useEffect, useRef } from 'react';
import { format, formatDistanceToNow, isSameDay } from 'date-fns';
import { Bot, Paperclip } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import type { DeskMessage } from '@/hooks/queries/use-desk-queries';
import type { DeskWorkspaceMember } from '@/hooks/queries/use-desk-workspace-members';

interface MessagesTimelineProps {
  messages: DeskMessage[];
  members: DeskWorkspaceMember[];
}

function memberLabel(members: DeskWorkspaceMember[], userId: string | null | undefined): string | null {
  if (!userId) return null;
  return members.find((m) => m.userId === userId)?.name ?? null;
}

function eventSentence(message: DeskMessage, members: DeskWorkspaceMember[]) {
  const t = getTranslations('deskInbox2');
  const actor = memberLabel(members, message.authorId) ?? t.timeline.unknownActor;
  const eventType = message.metadata?.eventType;
  if (eventType === 'closed') return t.timeline.closed.replace('{actor}', actor);
  if (eventType === 'reopened') return t.timeline.opened.replace('{actor}', actor);
  if (eventType === 'unassigned') return t.timeline.assignmentUnassigned.replace('{actor}', actor);
  if (eventType === 'assigned') {
    const target = memberLabel(members, message.metadata?.assigneeId ?? null) ?? message.metadata?.assigneeId ?? '';
    return t.timeline.assignmentToAdmin.replace('{actor}', actor).replace('{target}', target);
  }
  return message.body || t.timeline.genericEvent.replace('{actor}', actor).replace('{event}', eventType ?? 'event');
}

export function MessagesTimeline({ messages, members }: MessagesTimelineProps) {
  const t = getTranslations('deskInbox2');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  if (messages.length === 0) {
    return <p className="text-sm text-muted-foreground text-center py-8">{t.pane.partsEmpty}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {messages.map((message, index) => {
        const prev = messages[index - 1];
        const showDay =
          !prev || !isSameDay(new Date(prev.createdAt), new Date(message.createdAt));

        if (message.kind === 'event') {
          return (
            <div key={message.id}>
              {showDay && (
                <p className="text-[11px] text-muted-foreground text-center py-2">
                  {format(new Date(message.createdAt), 'PPP')}
                </p>
              )}
              <p className="text-xs text-muted-foreground text-center">
                {eventSentence(message, members)} ·{' '}
                {formatDistanceToNow(new Date(message.createdAt), { addSuffix: true })}
              </p>
            </div>
          );
        }

        const isVisitor = message.authorType === 'visitor';
        const isNote = message.kind === 'note';
        const isBot = message.authorType === 'bot';
        const label = isVisitor
          ? t.pane.you
          : isBot
            ? t.pane.ai
            : memberLabel(members, message.authorId) ?? 'Agent';
        const member = members.find((m) => m.userId === message.authorId);

        return (
          <div key={message.id}>
            {showDay && (
              <p className="text-[11px] text-muted-foreground text-center py-2">
                {format(new Date(message.createdAt), 'PPP')}
              </p>
            )}
            <div className={cn('flex gap-2', isVisitor ? 'flex-row' : 'flex-row')}>
              <Avatar className="h-7 w-7 mt-0.5">
                {member?.picture && <AvatarImage src={member.picture} />}
                <AvatarFallback className="text-[10px]">
                  {isBot ? <Bot className="h-3.5 w-3.5" /> : label.slice(0, 1).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div
                className={cn(
                  'rounded-lg px-3 py-2 max-w-[80%] text-sm',
                  isNote
                    ? 'bg-amber-50 dark:bg-amber-950/40 border border-amber-200/70 dark:border-amber-900'
                    : isVisitor
                      ? 'bg-muted'
                      : 'bg-primary/10',
                )}
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-xs font-medium">{isNote ? `${label} · ${t.composer.noteTab}` : label}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {formatDistanceToNow(new Date(message.createdAt), { addSuffix: true })}
                  </span>
                </div>
                {message.body && <p className="whitespace-pre-wrap break-words">{message.body}</p>}
                {message.attachments && message.attachments.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1">
                    {message.attachments.map((attachment) => (
                      <a
                        key={attachment.url}
                        href={attachment.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        <Paperclip className="h-3 w-3" />
                        {attachment.name}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
