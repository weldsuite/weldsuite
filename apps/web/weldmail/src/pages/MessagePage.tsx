import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { MailMessage } from '@weldsuite/personal-api-client';
import { personalApi } from '@/lib/api';

export function MessagePage() {
  const { id } = useParams<{ id: string }>();
  const [message, setMessage] = useState<MailMessage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const { data } = await personalApi.mailMessages.get(id!);
        if (cancelled) return;
        setMessage(data);
        if (!data.isRead) {
          const { data: updated } = await personalApi.mailMessages.patch(id!, { isRead: true });
          if (!cancelled) setMessage(updated);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load message');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <div className="h-7 w-7 animate-spin rounded-full border-2 border-border border-t-primary" />
      </div>
    );
  }

  if (error || !message) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-[53px] shrink-0 items-center border-b border-border px-4">
          <Link
            to="/inbox"
            className="inline-flex h-8 items-center rounded-md border border-border px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            ← Inbox
          </Link>
        </div>
        <div className="m-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error || 'Message not found'}
        </div>
      </div>
    );
  }

  const body = message.textBody || message.htmlBody?.replace(/<[^>]+>/g, ' ') || '';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[53px] shrink-0 items-center gap-2 border-b border-border px-4">
        <Link
          to="/inbox"
          className="inline-flex h-8 items-center rounded-md border border-border px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          ← Inbox
        </Link>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {message.subject || '(no subject)'}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          From{' '}
          {message.from?.name
            ? `${message.from.name} <${message.from.email}>`
            : message.from?.email}
          {message.sentDate ? ` · ${new Date(message.sentDate).toLocaleString()}` : null}
        </p>
        <div className="mt-6 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
          {body || '(empty message)'}
        </div>
      </div>
    </div>
  );
}
