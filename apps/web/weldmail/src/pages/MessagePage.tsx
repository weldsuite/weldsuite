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
      <div className="center-state">
        <div className="spinner" />
      </div>
    );
  }

  if (error || !message) {
    return (
      <div className="panel">
        <div className="status-banner error">{error || 'Message not found'}</div>
        <Link to="/inbox" className="btn btn-ghost">
          Back to inbox
        </Link>
      </div>
    );
  }

  const body = message.textBody || message.htmlBody?.replace(/<[^>]+>/g, ' ') || '';

  return (
    <div className="panel message-detail">
      <div className="toolbar">
        <Link to="/inbox" className="btn btn-ghost">
          ← Inbox
        </Link>
      </div>
      <h1>{message.subject || '(no subject)'}</h1>
      <p className="from-line">
        From{' '}
        {message.from?.name
          ? `${message.from.name} <${message.from.email}>`
          : message.from?.email}
        {message.sentDate ? ` · ${new Date(message.sentDate).toLocaleString()}` : null}
      </p>
      <div className="body">{body || '(empty message)'}</div>
    </div>
  );
}
