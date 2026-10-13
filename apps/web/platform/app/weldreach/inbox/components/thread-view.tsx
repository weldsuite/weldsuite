/**
 * The right pane of the inbox: one conversation (the steps we sent and the
 * replies, in order), its label, handled state and CRM link, and the composer.
 * Opening a thread marks its replies as read.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ExternalLink,
  Inbox,
  UserPlus,
  Undo2,
} from 'lucide-react';
import { toast } from 'sonner';
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
import {
  InboundKindBadge,
  REPLY_LABEL_ORDER,
  ReplyLabelBadge,
  replyLabelKey,
} from '@/app/weldreach/components/engage/badges';
import { personName, useReachFormat } from '@/app/weldreach/components/engage/format';
import {
  EmptyText,
  ErrorBanner,
  InlineSpinner,
  errorMessage,
} from '@/app/weldreach/components/engage/kit';
import {
  canReplyToThread,
  isHandled,
  messageText,
  sortMessages,
  unreadInboundIds,
} from '../lib/thread-state';
import { AddToCrmDialog } from './add-to-crm-dialog';
import { ReplyComposer } from './reply-composer';

export function ThreadView({
  threadKey,
  onBack,
}: Readonly<{ threadKey: string; onBack: () => void }>) {
  const t = useTranslations();
  const { data: thread, isLoading, error } = useReachThread(threadKey);

  if (isLoading) return <InlineSpinner className="flex-1" />;
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
  const [failure, setFailure] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const markedRead = useRef(new Set<string>());

  const canUpdate = can('reach_inbox:update');
  const canReply = can('reach_inbox:reply');
  const { summary } = thread;
  const messages = useMemo(() => sortMessages(thread.messages), [thread.messages]);
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

  // Show the latest message when a conversation opens or a new one arrives.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [thread.threadKey, messages.length]);

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

  const label = summary.lastInbound.label ?? 'unclassified';
  const labelSource = messages.find((message) => message.id === summary.lastInbound.id)?.labelSource ?? null;
  const personId = summary.prospect?.personId ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="space-y-3 border-b px-4 py-3">
        <div className="flex items-start gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="-ml-2 h-8 w-8 shrink-0 md:hidden"
            onClick={onBack}
            aria-label={t('reachEngage.common.back')}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold">{prospectLabel}</h2>
            <p className="truncate text-xs text-muted-foreground">
              {[
                prospectName ? summary.prospect?.email : null,
                summary.prospect?.companyName,
                summary.campaign?.name,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {t('reachEngage.inbox.thread.viaMailbox', { mailbox: summary.mailbox.email })}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canUpdate ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8" disabled={update.isPending}>
                  <ReplyLabelBadge label={label} source={labelSource} />
                  <ChevronDown className="ml-1.5 h-4 w-4" />
                  <span className="sr-only">{t('reachEngage.inbox.thread.changeLabel')}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {REPLY_LABEL_ORDER.map((option) => (
                  <DropdownMenuItem key={option} onSelect={() => void change({ label: option })}>
                    <span className="flex-1">{t(replyLabelKey(option))}</span>
                    {option === label && <Check className="h-4 w-4" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <ReplyLabelBadge label={label} source={labelSource} />
          )}

          {canUpdate && (
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              disabled={update.isPending}
              onClick={() => void change({ handled: !handled })}
            >
              {handled ? <Undo2 className="mr-1.5 h-4 w-4" /> : <Check className="mr-1.5 h-4 w-4" />}
              {handled ? t('reachEngage.inbox.thread.reopen') : t('reachEngage.inbox.thread.markHandled')}
            </Button>
          )}

          {personId ? (
            <Button asChild variant="outline" size="sm" className="h-8">
              <Link href={`/weldcrm/people?stack=person:${personId}:panel`}>
                <ExternalLink className="mr-1.5 h-4 w-4" />
                {t('reachEngage.inbox.thread.openInCrm')}
              </Link>
            </Button>
          ) : (
            canUpdate &&
            summary.prospect && (
              <Button variant="outline" size="sm" className="h-8" onClick={() => setCrmOpen(true)}>
                <UserPlus className="mr-1.5 h-4 w-4" />
                {t('reachEngage.inbox.thread.addToCrm')}
              </Button>
            )
          )}
        </div>
        <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <EmptyText>{t('reachEngage.inbox.thread.empty')}</EmptyText>
        ) : (
          messages.map((message) => (
            <MessageCard key={message.id} message={message} prospectLabel={prospectLabel} />
          ))
        )}
        <div ref={bottom} />
      </div>

      {canReply &&
        (replyAllowed ? (
          <ReplyComposer threadKey={thread.threadKey} mailboxEmail={summary.mailbox.email} />
        ) : (
          <p className="border-t px-4 py-3 text-sm text-muted-foreground">
            {t('reachEngage.inbox.composer.bounced')}
          </p>
        ))}

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

const OUTBOUND_STATUS_KEYS: Record<NonNullable<ReachMessage['status']>, string> = {
  sending: 'reachEngage.inbox.thread.status.sending',
  sent: 'reachEngage.inbox.thread.status.sent',
  failed: 'reachEngage.inbox.thread.status.failed',
  unknown: 'reachEngage.inbox.thread.status.unknown',
};

function MessageCard({
  message,
  prospectLabel,
}: Readonly<{ message: ReachMessage; prospectLabel: string }>) {
  const t = useTranslations();
  const format = useReachFormat();
  const outbound = message.direction === 'out';
  const text = messageText(message);
  const when = message.receivedAt ?? message.sentAt;

  return (
    <article
      className={cn(
        'space-y-2 rounded-lg border p-4',
        outbound ? 'ml-6 bg-muted/30 md:ml-12' : 'mr-6 bg-background md:mr-12',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">
            {outbound ? t('reachEngage.inbox.thread.sentBy', { mailbox: message.fromEmail }) : prospectLabel}
          </span>
          {outbound && message.status && message.status !== 'sent' && (
            <Badge variant={message.status === 'failed' ? 'destructive' : 'warning'}>
              {t(OUTBOUND_STATUS_KEYS[message.status])}
            </Badge>
          )}
          {!outbound && <InboundKindBadge kind={message.kind} />}
          {!outbound && message.kind === 'reply' && message.label && message.label !== 'unclassified' && (
            <ReplyLabelBadge label={message.label} source={message.labelSource} />
          )}
        </div>
        {when && (
          <time dateTime={when} className="shrink-0 text-xs text-muted-foreground">
            {format.dateTime(when)}
          </time>
        )}
      </div>

      {message.subject && <p className="text-sm font-medium">{message.subject}</p>}

      {text ? (
        <p className="whitespace-pre-wrap break-words text-sm">{text}</p>
      ) : (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Inbox className="h-4 w-4" />
          {t('reachEngage.inbox.thread.noBody')}
        </p>
      )}
    </article>
  );
}
