import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Paperclip, RefreshCw } from 'lucide-react';
import type { MailMessage } from '@weldsuite/personal-api-client';
import { personalApi } from '@/lib/api';
import { useMailEvents, type NewMailEvent } from '@/contexts/mail-events';
import { cn } from '@/lib/utils';

const FOLDERS = [
  { label: 'Inbox', value: 'INBOX' },
  { label: 'Sent', value: 'SENT' },
] as const;

type FolderValue = (typeof FOLDERS)[number]['value'];

function isFolder(value: string | null): value is FolderValue {
  return FOLDERS.some((f) => f.value === value);
}

function formatDate(value: string | Date | undefined | null): string {
  if (!value) return '';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function InboxPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const folderParam = searchParams.get('folder');
  const folder: FolderValue = isFolder(folderParam) ? folderParam : 'INBOX';

  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { onNewMail, connectionState } = useMailEvents();

  // The realtime handler needs the current folder without re-subscribing every
  // time the folder changes.
  const folderRef = useRef(folder);
  folderRef.current = folder;

  const load = useCallback(
    async (label: FolderValue, mode: 'initial' | 'refresh' = 'initial') => {
      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);
      setError(null);
      try {
        const { data } = await personalApi.mailMessages.list({ label, limit: 50 });
        setMessages(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load messages');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load(folder);
  }, [folder, load]);

  // A new message arrives over the WebSocket carrying enough fields to render a
  // row immediately, so the list updates without waiting on a refetch.
  useEffect(() => {
    return onNewMail((event: NewMailEvent) => {
      if (folderRef.current !== 'INBOX') return;

      setMessages((prev) => {
        if (prev.some((m) => m.id === event.messageId)) return prev;
        const row: MailMessage = {
          id: event.messageId,
          personalAccountId: '',
          accountId: event.accountId,
          messageId: event.smtpMessageId ?? event.messageId,
          threadId: event.threadId ?? null,
          from: event.from,
          to: [],
          subject: event.subject,
          preview: event.preview,
          sentDate: event.receivedAt,
          isRead: event.isRead,
          hasAttachments: event.hasAttachments,
          labels: ['INBOX'],
        };
        return [row, ...prev];
      });
    });
  }, [onNewMail]);

  function selectFolder(next: FolderValue) {
    setSearchParams(next === 'INBOX' ? {} : { folder: next }, { replace: true });
  }

  const emptyLabel =
    folder === 'SENT' ? "You haven't sent anything yet." : 'Your inbox is empty.';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[53px] shrink-0 items-center justify-between gap-3 border-b border-border px-4">
        <div className="flex items-center gap-1">
          {FOLDERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => selectFolder(f.value)}
              className={cn(
                'rounded-md px-2.5 py-1 text-sm transition-colors',
                folder === f.value
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {f.label}
            </button>
          ))}
          {connectionState === 'connected' && (
            <span
              className="ml-1.5 h-1.5 w-1.5 rounded-full bg-emerald-500"
              title="Live — new mail appears automatically"
            />
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load(folder, 'refresh')}
            disabled={refreshing}
            aria-label="Refresh"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
          </button>
          <Link
            to="/compose"
            className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Compose
          </Link>
        </div>
      </div>

      {error && (
        <div className="m-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          <div className="h-7 w-7 animate-spin rounded-full border-2 border-border border-t-primary" />
        </div>
      ) : messages.length === 0 ? (
        <p className="px-4 py-8 text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {messages.map((msg) => {
            const unread = !msg.isRead;
            // A Sent row is about who received it, not who sent it.
            const counterparty =
              folder === 'SENT'
                ? msg.to?.[0]?.name || msg.to?.[0]?.email || '(no recipient)'
                : msg.from?.name || msg.from?.email || 'Unknown';

            return (
              <li key={msg.id}>
                <Link
                  to={`/inbox/${msg.id}`}
                  className="group flex gap-3 border-b border-border px-4 py-3 transition-colors hover:bg-muted/50"
                >
                  <div className="relative mt-1.5 w-2 shrink-0">
                    {unread && (
                      <span className="absolute left-0 top-0 h-1.5 w-1.5 rounded-full bg-blue-600" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="mb-0.5 flex items-baseline justify-between gap-3">
                      <span
                        className={cn(
                          'truncate text-sm',
                          unread
                            ? 'font-semibold text-foreground'
                            : 'font-medium text-muted-foreground',
                        )}
                      >
                        {folder === 'SENT' ? `To: ${counterparty}` : counterparty}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                        {msg.hasAttachments && <Paperclip className="h-3 w-3" />}
                        {formatDate(msg.sentDate)}
                      </span>
                    </div>
                    <div
                      className={cn(
                        'truncate text-sm',
                        unread ? 'font-semibold text-foreground' : 'text-foreground',
                      )}
                    >
                      {msg.subject || '(no subject)'}
                    </div>
                    {msg.preview && (
                      <p className="mt-0.5 truncate text-sm text-muted-foreground">{msg.preview}</p>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
