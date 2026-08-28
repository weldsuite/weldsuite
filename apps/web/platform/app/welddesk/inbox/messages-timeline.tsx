import { useEffect, useRef } from 'react';
import { format, isSameDay } from 'date-fns';
import { Bot, Paperclip } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
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

function getAvatarColor(name: string): string {
  const colors = [
    '#4F46E5', '#7C3AED', '#EC4899', '#EF4444', '#F97316',
    '#EAB308', '#22C55E', '#14B8A6', '#06B6D4', '#3B82F6',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
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
    return <p className="text-sm text-muted-foreground text-center py-16">{t.pane.partsEmpty}</p>;
  }

  return (
    <div className="flex flex-col">
      {messages.map((message, index) => {
        const prev = messages[index - 1];
        const showDay = !prev || !isSameDay(new Date(prev.createdAt), new Date(message.createdAt));

        if (message.kind === 'event') {
          return (
            <div key={message.id}>
              {showDay && (
                <div className="relative flex items-center gap-2 px-3 md:px-4 h-8 bg-background border-t border-b border-border/70">
                  <div className="absolute inset-0 bg-muted/50 pointer-events-none" />
                  <span className="relative text-xs font-medium text-muted-foreground">
                    {format(new Date(message.createdAt), 'PPP')}
                  </span>
                </div>
              )}
              <p className="text-xs text-muted-foreground text-center py-3 px-4">
                {eventSentence(message, members)} · {format(new Date(message.createdAt), 'h:mm a')}
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
              <div className="relative flex items-center gap-2 px-3 md:px-4 h-8 bg-background border-t border-b border-border/70">
                <div className="absolute inset-0 bg-muted/50 pointer-events-none" />
                <span className="relative text-xs font-medium text-muted-foreground">
                  {format(new Date(message.createdAt), 'PPP')}
                </span>
              </div>
            )}
            <div
              className={cn(
                'px-3 md:px-4 py-3 md:py-4 border-b border-gray-100 dark:border-border',
                isNote && 'bg-amber-50/50 dark:bg-amber-950/20',
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  {member?.picture ? (
                    <img
                      src={member.picture}
                      alt={label}
                      className="w-6 h-6 rounded-md object-cover flex-shrink-0"
                    />
                  ) : (
                    <div
                      className="w-6 h-6 rounded-md flex items-center justify-center text-white font-semibold text-xs flex-shrink-0"
                      style={{ backgroundColor: getAvatarColor(label) }}
                    >
                      {isBot ? <Bot className="h-3.5 w-3.5" /> : label.slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-gray-900 dark:text-foreground text-[14.5px] truncate">
                        {isNote ? `${label} · ${t.composer.noteTab}` : label}
                      </span>
                    </div>
                  </div>
                </div>
                <span className="text-sm text-gray-700 dark:text-muted-foreground flex-shrink-0">
                  {format(new Date(message.createdAt), 'd MMM, HH:mm')}
                </span>
              </div>
              {message.body && (
                <p className="mt-3 text-[14.5px] text-gray-800 dark:text-foreground whitespace-pre-wrap break-words leading-relaxed">
                  {message.body}
                </p>
              )}
              {message.attachments && message.attachments.length > 0 && (
                <div className="mt-3 flex flex-col gap-1">
                  {message.attachments.map((attachment) => (
                    <a
                      key={attachment.url}
                      href={attachment.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                    >
                      <Paperclip className="h-3 w-3" />
                      {attachment.name}
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
