
import { useParams, useRouter, useSearchParams } from '@/lib/router';
import { useEffect, useRef, useMemo } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useQueryClient } from '@tanstack/react-query';
import {
  useMailMessage,
  useMailThread,
  useMailLabels,
  useMailDrafts,
  useMarkThreadAsRead,
  mailKeys,
} from '@/hooks/queries/use-mail-queries';
import { MessageDetail } from '../../../components/message-detail';
import { getLabelDisplayName } from '../../../lib/label-config';
import type { Mail } from '@/lib/api/types/apps/mail.types';
import { PageLoader } from '@/components/page-loader';

type EmailMessage = Mail.Email;

function mapMessage(
  msg: Record<string, unknown>,
  labelSlug: string,
  noSubject: string,
  unknown: string,
): EmailMessage {
  const from = msg.from as { email?: string; name?: string } | string | null | undefined;
  const fromEmail =
    typeof from === 'object' && from !== null ? from.email : (from as string | undefined);
  const fromName =
    typeof from === 'object' && from !== null
      ? from.name
      : (msg.fromName as string | undefined);

  const mapAddresses = (arr: unknown): string[] =>
    Array.isArray(arr)
      ? arr.map((t: unknown) =>
          typeof t === 'object' && t !== null ? (t as { email?: string }).email ?? '' : String(t),
        )
      : [];

  return {
    id: msg.id as string,
    messageId: msg.messageId as string,
    subject: (msg.subject as string) || noSubject,
    from: fromName || fromEmail || unknown,
    fromEmail: fromEmail,
    to: mapAddresses(msg.to),
    cc: mapAddresses(msg.cc),
    bcc: mapAddresses(msg.bcc),
    bodyText: (msg.textBody as string) || (msg.body as string) || '',
    bodyHtml: (msg.htmlBody as string) || '',
    preview: (msg.preview as string) || '',
    date: new Date(
      (msg.receivedDate as string) || (msg.sentDate as string) || (msg.createdAt as string),
    ),
    isRead: (msg.isRead as boolean) ?? false,
    isStarred: (msg.isStarred as boolean) ?? false,
    isImportant: (msg.isImportant as boolean) ?? false,
    isDraft: (msg.isDraft as boolean) ?? false,
    isSpam: (msg.isSpam as boolean) ?? false,
    isDeleted: (msg.isTrash as boolean) ?? false,
    hasAttachments: (msg.hasAttachments as boolean) ?? false,
    size: 1024,
    labels: (msg.labels as string[]) || [],
    folder: getLabelDisplayName(labelSlug),
    inReplyTo: msg.inReplyTo as string | undefined,
    references: msg.references as string[] | undefined,
    scheduledFor: msg.scheduledFor as string | undefined,
    sendStatus: msg.sendStatus as string | undefined,
  };
}

export default function UnifiedMessagePage() {
  const { t } = useI18n();
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const labelSlug = decodeURIComponent(params.labelSlug as string);
  const messageId = params.messageId as string;
  // accountId hint from the thread-list URL param (fast path, may be absent)
  const accountIdHint = searchParams?.get('accountId') || null;
  const queryClient = useQueryClient();
  const markThreadRead = useMarkThreadAsRead();

  const isDraft = messageId.startsWith('draft-');

  // Redirect drafts — unified view can't handle them without a known account
  useEffect(() => {
    if (isDraft) {
      router.replace(`/weldmail/unified/${labelSlug}`);
    }
  }, [isDraft, labelSlug, router]);

  // Refetch on mail:refresh (e.g. contact renamed)
  useEffect(() => {
    const handler = () => {
      queryClient.invalidateQueries({ queryKey: mailKeys.message(messageId) });
      queryClient.invalidateQueries({ queryKey: mailKeys.thread(messageId) });
    };
    window.addEventListener('mail:refresh', handler);
    return () => window.removeEventListener('mail:refresh', handler);
  }, [messageId, queryClient]);

  // --- Declarative data fetching via app-api hooks ---

  // The app-api `GET /mail-messages/:id` is workspace-scoped and does NOT require
  // an accountId path segment — it resolves the message across all accounts in the
  // tenant. The accountIdHint from the URL query param is retained as a hint for
  // the thread/labels/drafts hooks that do accept an accountId filter.
  const { data: messageData, isLoading: messageLoading } = useMailMessage(
    messageId,
    !isDraft,
  );

  const msg = messageData?.data;

  // Resolved accountId: prefer the field on the returned message, fall back to hint
  const resolvedAccountId: string | null = msg?.accountId ?? accountIdHint;

  // Server thread operations (mark-read, archive, label, …) key off the
  // stored thread id via `COALESCE(thread_id, id)` — the provider thread id
  // (Gmail threadId / Outlook conversationId), NOT an RFC-header-derived value.
  // We must send the same key, else the UPDATE matches zero rows and the
  // message silently reverts to unread on the next refetch.
  const threadId = useMemo(
    () => (msg ? msg.threadId ?? msg.id : null),
    [msg],
  );

  const { data: threadData } = useMailThread(
    resolvedAccountId ?? '',
    messageId,
    !!msg && !isDraft,
  );
  const { data: labelsData } = useMailLabels(resolvedAccountId ?? undefined, !!msg && !isDraft);
  const { data: draftsData } = useMailDrafts(resolvedAccountId ?? undefined, !!msg && !isDraft);

  // --- Derive component-ready values ---

  const selectedMessage = useMemo<EmailMessage | null>(
    () =>
      msg
        ? mapMessage(
            msg as unknown as Record<string, unknown>,
            labelSlug,
            t.mail.shared.noSubject,
            t.mail.shared.unknown,
          )
        : null,
    [msg, labelSlug, t.mail.shared.noSubject, t.mail.shared.unknown],
  );

  const threadMessages = useMemo<EmailMessage[]>(() => {
    const messages = threadData?.data?.messages ?? [];
    return messages
      .filter((m) => m.id !== messageId)
      .map((m) =>
        mapMessage(
          m as unknown as Record<string, unknown>,
          labelSlug,
          t.mail.shared.noSubject,
          t.mail.shared.unknown,
        ),
      )
      .sort((a, b) => a.date.getTime() - b.date.getTime());
  }, [threadData, messageId, labelSlug, t.mail.shared.noSubject, t.mail.shared.unknown]);

  const availableLabels = useMemo<Mail.Label[]>(
    () => (labelsData?.data as Mail.Label[] | undefined) ?? [],
    [labelsData],
  );

  const threadDrafts = useMemo<
    {
      id: string;
      to: string[];
      subject: string;
      body: string;
      htmlBody: string;
      inReplyTo: string;
      updatedAt: string;
    }[]
  >(() => {
    const allDrafts = draftsData?.data ?? [];
    const allRfcIds = new Set<string>();
    if (selectedMessage?.messageId) allRfcIds.add(selectedMessage.messageId);
    for (const tm of threadMessages) {
      if (tm.messageId) allRfcIds.add(tm.messageId);
    }
    if (allRfcIds.size === 0) return [];
    return allDrafts
      .filter((d) => d.inReplyTo !== null && allRfcIds.has(d.inReplyTo!))
      .map((d) => ({
        id: d.id,
        to: d.to ?? [],
        subject: d.subject ?? '',
        body: d.body ?? '',
        htmlBody: d.htmlBody ?? '',
        inReplyTo: d.inReplyTo!,
        updatedAt: d.updatedAt || d.createdAt,
      }));
  }, [draftsData, selectedMessage, threadMessages]);

  // Bulk-mark thread siblings as read after the focused message loads
  const lastRefreshedId = useRef<string | null>(null);
  useEffect(() => {
    if (selectedMessage && messageId !== lastRefreshedId.current) {
      lastRefreshedId.current = messageId;
      // Consider the focused message itself — `threadMessages` excludes it, so a
      // single unread email (no siblings) would otherwise never be marked read.
      const hasUnread =
        !selectedMessage.isRead || threadMessages.some((m) => !m.isRead);
      if (hasUnread && threadId && resolvedAccountId) {
        markThreadRead.mutate(
          { accountId: resolvedAccountId, threadId, isRead: true },
          { onSuccess: () => window.dispatchEvent(new Event('mail:refresh')) },
        );
      } else {
        window.dispatchEvent(new Event('mail:refresh'));
      }
    }
  }, [selectedMessage, messageId, threadMessages, threadId, resolvedAccountId, markThreadRead]);

  if (isDraft) {
    return <PageLoader fullScreen={false} />;
  }

  if (messageLoading) return <PageLoader fullScreen={false} />;

  if (!selectedMessage || !resolvedAccountId) {
    return (
      <div className="flex items-center justify-center p-8">{t.mail.shared.messageNotFound}</div>
    );
  }

  return (
    <MessageDetail
      message={selectedMessage}
      thread={threadMessages}
      accountId={resolvedAccountId}
      folder={labelSlug}
      availableLabels={availableLabels}
      threadId={threadId ?? undefined}
      drafts={threadDrafts}
    />
  );
}
