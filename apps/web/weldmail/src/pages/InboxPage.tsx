import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MailMessage } from '@weldsuite/personal-api-client';
import { personalApi } from '@/lib/api';
import { cn } from '@/lib/utils';

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
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await personalApi.mailMessages.list({ label: 'INBOX', limit: 50 });
      setMessages(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load inbox');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[53px] shrink-0 items-center justify-between gap-3 border-b border-border px-4">
        <div>
          <h1 className="text-sm font-semibold text-foreground">Inbox</h1>
          <p className="text-xs text-muted-foreground">Messages labeled INBOX</p>
        </div>
        <Link
          to="/compose"
          className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Compose
        </Link>
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
        <p className="px-4 py-8 text-sm text-muted-foreground">Your inbox is empty.</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {messages.map((msg) => {
            const unread = !msg.isRead;
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
                        {msg.from?.name || msg.from?.email || 'Unknown'}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
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
