/**
 * The right pane of the inbox, laid out like WeldMail's message view: a header
 * bar with the subject and the actions (handled, label, CRM), the newest
 * message in full with Reply under it, and the earlier messages below as
 * cards that open on a click. Opening a thread marks its replies as read.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ExternalLink,
  Inbox,
  Reply,
  Tag,
  UserPlus,
  Undo2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type {
  ReachMessage,
  ReachReplyLabel,
  ReachThread,
} from '@weldsuite/app-api-client/schemas/reach';
import {
  useReachThread,
  useUpdateReachMessage,
} from '@/hooks/queries/use-reach-inbox-queries';
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';
import { getAvatarColor } from '@/components/shared/conversation-list';
import {
  InboundKindBadge,
  REPLY_LABEL_ORDER,
  ReplyLabelBadge,
  replyLabelKey,
} from '@/app/weldreach/components/engage/badges';
import { personName, useReachFormat } from '@/app/weldreach/components/engage/format';
import { errorMessage } from '@/app/weldreach/components/engage/kit';
import {
  canReplyToThread,
  isHandled,
  messageText,
  sortMessages,
  unreadInboundIds,
} from '../lib/thread-state';
import { AddToCrmDialog } from './add-to-crm-dialog';
import { ReplyComposer } from './reply-composer';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { ErrorBanner } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';

// WeldMail's header-bar icon buttons.
const ICON_BUTTON_CLASS =
  'md:size-7 p-1.5 hover:bg-gray-100 dark:hover:bg-secondary data-[state=open]:bg-gray-100 dark:data-[state=open]:bg-secondary rounded-md transition-colors';
const ICON_CLASS = 'h-4 w-4 text-gray-500 dark:text-muted-foreground';
const GROUP_BUTTON_CLASS = 'h-full w-7 p-1 hover:bg-gray-100 dark:hover:bg-secondary transition-colors';

export function ThreadView({
  threadKey,
  onBack,
}: Readonly<{ threadKey: string; onBack: () => void }>) {
  const t = useTranslations();
  const { data: thread, isLoading, error } = useReachThread(threadKey);

  if (isLoading) return <PageLoader fullScreen={false} />;
  if (!thread) {
    return (
      <div className="space-y-3 p-6">
        <ErrorBanner error={errorMessage(error, t('reachEngage.inbox.thread.loadFailed'))} />
        <Button variant="outline" size="sm" onClick={onBack}>
          {t('reachEngage.common.back')}
        </Button>
      </div>
    );
  }

  return <ThreadContent thread={thread} onBack={onBack} />;
}

function ThreadContent({ thread, onBack }: Readonly<{ thread: ReachThread; onBack: () => void }>) {
  const t = useTranslations();
  const { can } = usePermissions();
  const update = useUpdateReachMessage(thread.threadKey);
  // Reading a thread happens in the background, apart from the buttons' own pending state.
  const markRead = useUpdateReachMessage(thread.threadKey);
  const [crmOpen, setCrmOpen] = useState(false);
  const [replying, setReplying] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [failure, setFailure] = useState<string | null>(null);
  const markedRead = useRef(new Set<string>());

  const canUpdate = can('reach_inbox:update');
  const canReply = can('reach_inbox:reply');
  const { summary } = thread;
  const messages = useMemo(() => sortMessages(thread.messages), [thread.messages]);
  // Newest first, as in WeldMail: the latest message in full, the rest below it.
  const [newest, ...older] = useMemo(() => [...messages].reverse(), [messages]);
  const handled = isHandled(summary);
  const prospectName = summary.prospect ? personName(summary.prospect) : null;
  const prospectLabel = prospectName ?? summary.prospect?.email ?? t('reachEngage.inbox.unknownSender');
  const replyAllowed = canReplyToThread(messages);

  // Opening a conversation reads its replies. Each id is marked once, so a refetch
  // that still shows it unread (the PATCH has not landed yet) does not repeat it.
  const unreadIds = unreadInboundIds(messages);
  useEffect(() => {
    if (!canUpdate) return;
    for (const id of unreadIds) {
      if (markedRead.current.has(id)) continue;
      markedRead.current.add(id);
      markRead.mutate({ id, changes: { read: true } });
    }
    // `markRead` is a fresh object per render; only the unread ids decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUpdate, unreadIds.join(',')]);

  async function change(changes: { label?: ReachReplyLabel; handled?: boolean }) {
    setFailure(null);
    try {
      await update.mutateAsync({ id: summary.lastInbound.id, changes });
      if (changes.handled !== undefined) {
        toast.success(
          changes.handled ? t('reachEngage.inbox.thread.markedHandled') : t('reachEngage.inbox.thread.reopened'),
        );
      }
    } catch (err) {
      setFailure(errorMessage(err, t('reachEngage.inbox.thread.updateFailed')));
    }
  }

  function toggleExpanded(id: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const label = summary.lastInbound.label ?? 'unclassified';
  const labelSource = messages.find((message) => message.id === summary.lastInbound.id)?.labelSource ?? null;
  const personId = summary.prospect?.personId ?? null;
  const subject = summary.lastInbound.subject ?? newest?.subject ?? t('reachEngage.inbox.noSubject');
  const handledLabel = handled ? t('reachEngage.inbox.thread.reopen') : t('reachEngage.inbox.thread.markHandled');
  const parties = { prospectLabel, prospectEmail: summary.prospect?.email ?? null, mailbox: summary.mailbox.email };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-white dark:bg-background">
      <div className="flex h-[53px] flex-shrink-0 items-center justify-between border-b border-gray-200 px-3 dark:border-border md:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="-ml-1 flex-shrink-0 rounded-md p-1.5 transition-colors hover:bg-gray-100 md:hidden"
            onClick={onBack}
            aria-label={t('reachEngage.common.back')}
          >
            <ChevronLeft className="h-5 w-5 text-gray-600 dark:text-muted-foreground" />
          </Button>
          <div
            className={cn(
              'h-7 flex-shrink-0 items-center overflow-hidden rounded-md border border-border',
              canUpdate ? 'flex' : 'hidden md:flex',
            )}
          >
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn(GROUP_BUTTON_CLASS, 'hidden md:flex')}
              onClick={onBack}
              aria-label={t('reachEngage.inbox.thread.close')}
              title={t('reachEngage.inbox.thread.close')}
            >
              <X className="h-3.5 w-3.5 text-gray-500 dark:text-muted-foreground" />
            </Button>
            {canUpdate && (
              <>
                <div className="hidden h-4 w-px bg-border md:block" />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={GROUP_BUTTON_CLASS}
                  disabled={update.isPending}
                  onClick={() => void change({ handled: !handled })}
                  aria-label={handledLabel}
                  title={handledLabel}
                >
                  {handled ? (
                    <Undo2 className="h-3.5 w-3.5 text-gray-500 dark:text-muted-foreground" />
                  ) : (
                    <Check className="h-3.5 w-3.5 text-gray-500 dark:text-muted-foreground" />
                  )}
                </Button>
              </>
            )}
          </div>
          <h1 className="truncate text-sm font-semibold text-gray-900 dark:text-foreground md:ml-2 md:text-lg">
            {subject}
          </h1>
          {label !== 'unclassified' && (
            <span className="hidden flex-shrink-0 md:inline-flex">
              <ReplyLabelBadge label={label} source={labelSource} />
            </span>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center gap-0.5 md:gap-1">
          {canUpdate && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={ICON_BUTTON_CLASS}
                  disabled={update.isPending}
                  aria-label={t('reachEngage.inbox.thread.changeLabel')}
                  title={t('reachEngage.inbox.thread.changeLabel')}
                >
                  <Tag className={ICON_CLASS} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {REPLY_LABEL_ORDER.map((option) => (
                  <DropdownMenuItem key={option} onSelect={() => void change({ label: option })}>
                    <span className="flex-1">{t(replyLabelKey(option))}</span>
                    {option === label && <Check className="h-4 w-4" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {personId ? (
            <Button asChild variant="ghost" size="icon" className={ICON_BUTTON_CLASS}>
              <Link
                href={`/weldcrm/people?stack=person:${personId}:panel`}
                aria-label={t('reachEngage.inbox.thread.openInCrm')}
                title={t('reachEngage.inbox.thread.openInCrm')}
              >
                <ExternalLink className={ICON_CLASS} />
              </Link>
            </Button>
          ) : (
            canUpdate &&
            summary.prospect && (
              <Button
                variant="ghost"
                size="icon"
                className={ICON_BUTTON_CLASS}
                onClick={() => setCrmOpen(true)}
                aria-label={t('reachEngage.inbox.thread.addToCrm')}
                title={t('reachEngage.inbox.thread.addToCrm')}
              >
                <UserPlus className={ICON_CLASS} />
              </Button>
            )
          )}
        </div>
      </div>

      {failure && (
        <div className="px-3 pt-3 md:px-4">
          <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {replying && (
          <ReplyComposer
            threadKey={thread.threadKey}
            mailboxEmail={summary.mailbox.email}
            onCancel={() => setReplying(false)}
            onSent={() => setReplying(false)}
          />
        )}

        {newest ? (
          <article>
            <div className="px-3 py-3 md:px-4 md:py-4">
              <MessageHeading message={newest} parties={parties} />
            </div>
            <div className="px-3 md:px-4">
              <MessageBody message={newest} />
              <div className="mt-4 flex items-center justify-end gap-2 md:mt-6">
                {canReply && !replyAllowed && (
                  <p className="text-sm text-muted-foreground">{t('reachEngage.inbox.composer.bounced')}</p>
                )}
                {canReply && replyAllowed && !replying && (
                  <Button
                    variant="ghost"
                    onClick={() => setReplying(true)}
                    className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-gray-600 transition-colors hover:bg-gray-50 dark:border-border dark:text-muted-foreground dark:hover:bg-secondary md:flex-initial md:py-1.5"
                  >
                    <Reply className="h-4 w-4" />
                    <span className="text-sm">{t('reachEngage.inbox.thread.reply')}</span>
                  </Button>
                )}
              </div>
            </div>
          </article>
        ) : (
          <div className="p-4">
            <EmptyText>{t('reachEngage.inbox.thread.empty')}</EmptyText>
          </div>
        )}

        {older.length > 0 && (
          <div className="mb-4 space-y-4 px-3 pt-4 md:px-4">
            {older.map((message) => (
              <EarlierMessage
                key={message.id}
                message={message}
                parties={parties}
                isExpanded={expanded.has(message.id)}
                onToggle={() => toggleExpanded(message.id)}
              />
            ))}
          </div>
        )}
      </div>

      {crmOpen && (
        <AddToCrmDialog
          threadKey={thread.threadKey}
          prospectLabel={prospectLabel}
          onClose={() => setCrmOpen(false)}
        />
      )}
    </div>
  );
}

interface Parties {
  prospectLabel: string;
  prospectEmail: string | null;
  mailbox: string;
}

const OUTBOUND_STATUS_KEYS: Record<NonNullable<ReachMessage['status']>, string> = {
  sending: 'reachEngage.inbox.thread.status.sending',
  sent: 'reachEngage.inbox.thread.status.sent',
  failed: 'reachEngage.inbox.thread.status.failed',
  unknown: 'reachEngage.inbox.thread.status.unknown',
};

/** Who wrote a message and to whom: the prospect for replies, our mailbox for the steps we sent. */
function messageParties(message: ReachMessage, parties: Parties): { from: string; to: string } {
  if (message.direction === 'out') {
    return { from: message.fromEmail, to: message.toEmail || parties.prospectEmail || parties.prospectLabel };
  }
  return { from: parties.prospectLabel, to: message.toEmail || parties.mailbox };
}

function SenderAvatar({ name }: Readonly<{ name: string }>) {
  return (
    <Avatar className="size-6 flex-shrink-0">
      <AvatarFallback className="text-xs font-semibold text-white" style={{ backgroundColor: getAvatarColor(name) }}>
        {(name || '?').charAt(0).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

function MessageBadges({ message }: Readonly<{ message: ReachMessage }>) {
  const t = useTranslations();
  if (message.direction === 'out') {
    return message.status && message.status !== 'sent' ? (
      <Badge variant={message.status === 'failed' ? 'destructive' : 'warning'}>
        {t(OUTBOUND_STATUS_KEYS[message.status])}
      </Badge>
    ) : null;
  }
  return (
    <>
      <InboundKindBadge kind={message.kind} />
      {message.kind === 'reply' && message.label && message.label !== 'unclassified' && (
        <ReplyLabelBadge label={message.label} source={message.labelSource} />
      )}
    </>
  );
}

/** WeldMail's sender line: avatar, "Name to address", badges and the time. */
function MessageHeading({ message, parties }: Readonly<{ message: ReachMessage; parties: Parties }>) {
  const t = useTranslations();
  const format = useReachFormat();
  const { from, to } = messageParties(message, parties);
  const when = message.receivedAt ?? message.sentAt;

  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <SenderAvatar name={from} />
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate text-[14.5px] font-semibold text-gray-900 dark:text-foreground">{from}</span>
          <span className="text-[14.5px] text-gray-500 dark:text-muted-foreground">
            {t('reachEngage.inbox.thread.to')}
          </span>
          <span className="truncate text-[14.5px] text-blue-600" title={to}>
            {to}
          </span>
          <MessageBadges message={message} />
        </div>
      </div>
      {when && (
        <time dateTime={when} className="flex-shrink-0 text-sm text-gray-700 dark:text-muted-foreground">
          {format.dateTime(when)}
        </time>
      )}
    </div>
  );
}

function MessageBody({ message }: Readonly<{ message: ReachMessage }>) {
  const t = useTranslations();
  const text = messageText(message);
  if (!text) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Inbox className="h-4 w-4" />
        {t('reachEngage.inbox.thread.noBody')}
      </p>
    );
  }
  return (
    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-700 dark:text-foreground">
      {text}
    </p>
  );
}

/** An earlier message: WeldMail's collapsed thread card, opened with a click. */
function EarlierMessage({
  message,
  parties,
  isExpanded,
  onToggle,
}: Readonly<{ message: ReachMessage; parties: Parties; isExpanded: boolean; onToggle: () => void }>) {
  const format = useReachFormat();
  const { from } = messageParties(message, parties);
  const when = message.receivedAt ?? message.sentAt;

  return (
    <article className="rounded-lg border border-border/50 bg-muted/50">
      <button
        type="button"
        aria-expanded={isExpanded}
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:px-4"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <SenderAvatar name={from} />
          <span className="truncate text-sm font-medium text-foreground">{from}</span>
          <MessageBadges message={message} />
        </span>
        <span className="flex flex-shrink-0 items-center gap-2">
          {when && (
            <time dateTime={when} className="text-xs text-muted-foreground">
              {format.dateTime(when)}
            </time>
          )}
          <ChevronDown
            className={cn('h-4 w-4 text-muted-foreground transition-transform', isExpanded && 'rotate-180')}
          />
        </span>
      </button>
      {isExpanded && (
        <div className="px-3 pb-4 md:px-4">
          <MessageBody message={message} />
        </div>
      )}
    </article>
  );
}
