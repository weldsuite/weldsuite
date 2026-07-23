import { useEffect, useMemo, useRef } from 'react';
import { format, formatDistanceToNow, isSameDay } from 'date-fns';
import { Bot, Paperclip, Sparkles, Star } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge } from '@weldsuite/ui/components/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { IsolatedHtmlContent } from '@/app/weldmail/components/isolated-html-content';
import type { DeskConversationPart, DeskPartAuthorType } from '@/hooks/queries/use-desk-queries';
import type { DeskWorkspaceMember } from '@/hooks/queries/use-desk-workspace-members';
import type {
  ButtonGroupBlock,
  CardBlock,
  ContextBlock,
  DividerBlock,
  ImageBlock,
  MessageBlock,
  RatingBlock,
  TextBlock,
} from '@weldsuite/db/schema/welddesk-blocks';

interface PartsTimelineProps {
  parts: DeskConversationPart[];
  members: DeskWorkspaceMember[];
}

const EVENT_PART_TYPES = new Set<DeskConversationPart['partType']>([
  'open',
  'close',
  'snoozed',
  'unsnoozed',
  'timer_unsnooze',
  'assignment',
  'assign_and_unsnooze',
  'away_mode_assignment',
  'default_assignment',
  'balanced_assignment',
  'participant_added',
  'participant_removed',
  'conversation_rating_changed',
  'conversation_rating_remark_added',
  'ticket_state_changed',
  'ticket_attribute_updated',
  'converted_to_ticket',
  'linked_object_added',
  'linked_object_removed',
  'workflow_started',
  'workflow_ended',
]);

function memberLabel(members: DeskWorkspaceMember[], userId: string | null | undefined): string | null {
  if (!userId) return null;
  const member = members.find((m) => m.userId === userId);
  return member?.name ?? null;
}

function initialsOf(label: string): string {
  return label.trim().slice(0, 1).toUpperCase() || '?';
}

/** Builds the "Gert assigned this to Support · 2h ago"-style event sentence. */
function useEventSentence(part: DeskConversationPart, members: DeskWorkspaceMember[]) {
  const t = getTranslations('deskInbox2');

  return useMemo(() => {
    const actor = memberLabel(members, part.authorId) ?? t.timeline.unknownActor;
    const metadata = (part.metadata ?? {}) as Record<string, unknown>;

    switch (part.partType) {
      case 'assignment':
      case 'assign_and_unsnooze':
      case 'away_mode_assignment':
      case 'default_assignment':
      case 'balanced_assignment': {
        if (!part.assignedToId) return t.timeline.assignmentUnassigned.replace('{actor}', actor);
        if (part.assignedToType === 'team') {
          const teamName = typeof metadata.teamName === 'string' ? metadata.teamName : part.assignedToId;
          return t.timeline.assignmentToTeam.replace('{actor}', actor).replace('{target}', teamName);
        }
        const target = memberLabel(members, part.assignedToId) ?? part.assignedToId;
        return t.timeline.assignmentToAdmin.replace('{actor}', actor).replace('{target}', target);
      }
      case 'open':
        return t.timeline.opened.replace('{actor}', actor);
      case 'close':
        return t.timeline.closed.replace('{actor}', actor);
      case 'snoozed': {
        const until = typeof metadata.snoozedUntil === 'string' ? metadata.snoozedUntil : null;
        const dateLabel = until ? format(new Date(until), 'PPp') : '';
        return t.timeline.snoozed.replace('{actor}', actor).replace('{date}', dateLabel);
      }
      case 'unsnoozed':
        return t.timeline.unsnoozed.replace('{actor}', actor);
      case 'timer_unsnooze':
        return t.timeline.timerUnsnooze;
      case 'conversation_rating_changed':
      case 'conversation_rating_remark_added': {
        const rating = typeof metadata.rating === 'number' ? metadata.rating : null;
        return t.timeline.ratingChanged
          .replace('{actor}', actor)
          .replace('{rating}', rating !== null ? t.timeline.ratingLabel.replace('{rating}', String(rating)) : '');
      }
      case 'participant_added': {
        const target = memberLabel(members, typeof metadata.userId === 'string' ? metadata.userId : null) ?? '';
        return t.timeline.participantAdded.replace('{actor}', actor).replace('{target}', target);
      }
      case 'participant_removed': {
        const target = memberLabel(members, typeof metadata.userId === 'string' ? metadata.userId : null) ?? '';
        return t.timeline.participantRemoved.replace('{actor}', actor).replace('{target}', target);
      }
      case 'workflow_started': {
        const name = typeof metadata.workflowName === 'string' ? metadata.workflowName : '';
        return t.timeline.workflowStarted.replace('{name}', name);
      }
      case 'workflow_ended': {
        const name = typeof metadata.workflowName === 'string' ? metadata.workflowName : '';
        return t.timeline.workflowEnded.replace('{name}', name);
      }
      case 'converted_to_ticket':
        return t.timeline.convertedToTicket.replace('{actor}', actor);
      case 'linked_object_added':
        return t.timeline.linkedObjectAdded.replace('{actor}', actor);
      case 'linked_object_removed':
        return t.timeline.linkedObjectRemoved.replace('{actor}', actor);
      default:
        return t.timeline.genericEvent.replace('{actor}', actor).replace('{event}', part.partType);
    }
  }, [part, members, t]);
}

function EventPartRow({ part, members }: { part: DeskConversationPart; members: DeskWorkspaceMember[] }) {
  const sentence = useEventSentence(part, members);
  return (
    <div className="flex items-center justify-center py-1" data-testid="desk-inbox2-event-part">
      <span className="text-xs text-muted-foreground text-center">
        {sentence} · {formatDistanceToNow(new Date(part.createdAt), { addSuffix: true })}
      </span>
    </div>
  );
}

function AuthorAvatar({
  authorType,
  label,
  picture,
}: {
  authorType: DeskPartAuthorType;
  label: string;
  picture?: string | null;
}) {
  if (authorType === 'bot') {
    return (
      <Avatar className="h-6 w-6 shrink-0">
        <AvatarFallback className="bg-violet-600 text-white">
          <Bot className="h-3.5 w-3.5" />
        </AvatarFallback>
      </Avatar>
    );
  }
  return (
    <Avatar className="h-6 w-6 shrink-0">
      {picture && <AvatarImage src={picture} />}
      <AvatarFallback className="text-[11px]">{initialsOf(label)}</AvatarFallback>
    </Avatar>
  );
}

function TextBlockView({ block }: { block: TextBlock }) {
  return (
    <p
      className={cn(
        'text-sm whitespace-pre-wrap',
        block.style === 'muted' && 'text-muted-foreground',
        block.style === 'bold' && 'font-semibold',
        block.style === 'warning' && 'text-amber-600 dark:text-amber-400',
        block.style === 'error' && 'text-destructive',
      )}
    >
      {block.content}
    </p>
  );
}

function ButtonGroupBlockView({
  block,
  responses,
}: {
  block: ButtonGroupBlock;
  responses: Record<string, unknown> | null | undefined;
}) {
  const response = responses?.[block.actionId] as
    | { value?: { selectedIds?: string[] } }
    | undefined;
  const selectedIds = new Set(response?.value?.selectedIds ?? []);
  return (
    <div className={cn('flex gap-2', block.layout === 'vertical' ? 'flex-col' : 'flex-wrap')}>
      {block.buttons.map((button) => (
        <Button
          key={button.id}
          type="button"
          size="sm"
          variant={selectedIds.has(button.id) ? 'default' : 'outline'}
          disabled
          className="pointer-events-none"
        >
          {button.label}
        </Button>
      ))}
    </div>
  );
}

function RatingBlockView({
  block,
  responses,
}: {
  block: RatingBlock;
  responses: Record<string, unknown> | null | undefined;
}) {
  const response = responses?.[block.actionId] as { value?: { rating?: number } } | undefined;
  const rating = response?.value?.rating ?? 0;
  if (block.style === 'stars') {
    return (
      <div className="flex items-center gap-1">
        {Array.from({ length: 5 }).map((_, i) => (
          <Star
            key={i}
            className={cn(
              'h-4 w-4',
              i < rating ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground',
            )}
          />
        ))}
      </div>
    );
  }
  return <span className="text-sm font-medium">{rating}</span>;
}

function ImageBlockView({ block }: { block: ImageBlock }) {
  return (
    <figure>
      <img src={block.url} alt={block.alt ?? ''} className="max-w-xs rounded-md border" />
      {block.caption && <figcaption className="text-xs text-muted-foreground mt-1">{block.caption}</figcaption>}
    </figure>
  );
}

function ContextBlockView({ block }: { block: ContextBlock }) {
  return <p className="text-xs text-muted-foreground">{block.content}</p>;
}

function DividerBlockView(_props: { block: DividerBlock }) {
  return <div className="h-px bg-border my-1" />;
}

function BlockView({
  block,
  responses,
  unsupportedLabel,
}: {
  block: MessageBlock;
  responses: Record<string, unknown> | null | undefined;
  unsupportedLabel: string;
}) {
  switch (block.type) {
    case 'text':
      return <TextBlockView block={block} />;
    case 'button_group':
      return <ButtonGroupBlockView block={block} responses={responses} />;
    case 'rating':
      return <RatingBlockView block={block} responses={responses} />;
    case 'image':
      return <ImageBlockView block={block} />;
    case 'context':
      return <ContextBlockView block={block} />;
    case 'divider':
      return <DividerBlockView block={block} />;
    default:
      return (
        <Badge variant="outline" className="text-[11px] font-normal text-muted-foreground">
          {unsupportedLabel}
        </Badge>
      );
  }
}

function AttachmentChips({ part }: { part: DeskConversationPart }) {
  if (!part.attachments || part.attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-1.5">
      {part.attachments.map((att) => (
        <a
          key={att.url}
          href={att.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs hover:bg-accent transition-colors"
        >
          <Paperclip className="h-3 w-3 shrink-0" />
          <span className="truncate max-w-[160px]">{att.name}</span>
        </a>
      ))}
    </div>
  );
}

function MessagePartBubble({
  part,
  members,
}: {
  part: DeskConversationPart;
  members: DeskWorkspaceMember[];
}) {
  const t = getTranslations('deskInbox2');
  const isCustomer = part.authorType === 'user';
  const isNote = part.partType === 'note' || part.partType === 'note_and_reopen';
  const isAiAnswer = part.partType === 'ai_answer' || part.isAiAnswer;

  const label = isCustomer
    ? t.pane.you // overwritten below when we know the contact name; kept as fallback
    : (memberLabel(members, part.authorId) ?? (part.authorType === 'bot' ? t.pane.ai : part.authorType));

  const bubbleClasses = cn(
    'max-w-[75%] rounded-lg px-3 py-2',
    isNote
      ? 'bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 w-full max-w-full'
      : isCustomer
        ? 'bg-muted'
        : 'bg-primary text-primary-foreground',
  );

  return (
    <div
      className={cn('flex gap-2', !isNote && (isCustomer ? 'justify-start' : 'justify-end'))}
      data-testid="desk-inbox2-part"
    >
      {(isNote || isCustomer) && (
        <AuthorAvatar authorType={part.authorType} label={label} picture={null} />
      )}
      <div className={cn('flex flex-col gap-1', isNote ? 'w-full' : 'max-w-[75%]')}>
        <div className={bubbleClasses}>
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-xs font-medium opacity-80">{label}</span>
            {isNote && (
              <Badge variant="outline" className="text-[10px] h-4 border-amber-400 text-amber-700 dark:text-amber-400">
                {t.partType.note}
              </Badge>
            )}
            {isAiAnswer && (
              <Badge variant="secondary" className="text-[10px] h-4 gap-1">
                <Sparkles className="h-2.5 w-2.5" />
                {t.pane.ai}
              </Badge>
            )}
          </div>
          {part.body && (
            <div className="text-sm [&_a]:underline">
              <IsolatedHtmlContent html={part.body} />
            </div>
          )}
          {part.blocks && part.blocks.length > 0 && (
            <div className="flex flex-col gap-2 mt-2">
              {(part.blocks as unknown as MessageBlock[]).map((block) => (
                <BlockView
                  key={block.id}
                  block={block}
                  responses={part.blockResponses}
                  unsupportedLabel={t.timeline.unsupportedBlock}
                />
              ))}
            </div>
          )}
          <AttachmentChips part={part} />
        </div>
        {!isNote && (
          <span className={cn('text-[11px] text-muted-foreground px-1', isCustomer ? 'text-left' : 'text-right')}>
            {formatDistanceToNow(new Date(part.createdAt), { addSuffix: true })}
          </span>
        )}
      </div>
      {!isNote && !isCustomer && (
        <AuthorAvatar authorType={part.authorType} label={label} picture={null} />
      )}
    </div>
  );
}

function DateSeparator({ date }: { date: Date }) {
  return (
    <div className="flex items-center justify-center py-2">
      <span className="text-[11px] font-medium text-muted-foreground bg-background px-2">
        {format(date, 'PPP')}
      </span>
    </div>
  );
}

/**
 * Renders the full parts timeline: message bubbles (comment/note/quick_reply/
 * ai_answer) + compact centered one-liners for every event part, with date
 * separators between days. Auto-scrolls to bottom on load + when new parts
 * arrive.
 */
export function PartsTimeline({ parts, members }: PartsTimelineProps) {
  const t = getTranslations('deskInbox2');
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastPartId = parts[parts.length - 1]?.id;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [lastPartId]);

  if (parts.length === 0) {
    return <p className="text-sm text-muted-foreground text-center py-8">{t.pane.partsEmpty}</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {parts.map((part, index) => {
        const createdAt = new Date(part.createdAt);
        const prevCreatedAt = index > 0 ? new Date(parts[index - 1]!.createdAt) : null;
        const showSeparator = !prevCreatedAt || !isSameDay(prevCreatedAt, createdAt);
        const isEvent = EVENT_PART_TYPES.has(part.partType);

        return (
          <div key={part.id} className="flex flex-col gap-2">
            {showSeparator && <DateSeparator date={createdAt} />}
            {isEvent ? (
              <EventPartRow part={part} members={members} />
            ) : (
              <MessagePartBubble part={part} members={members} />
            )}
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
