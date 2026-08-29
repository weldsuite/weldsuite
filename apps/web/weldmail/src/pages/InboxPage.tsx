import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MailMessage } from '@weldsuite/personal-api-client';
import { personalApi } from '@/lib/api';

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
    <div className="panel">
      <div className="toolbar">
        <div style={{ flex: 1 }}>
          <h1>Inbox</h1>
          <p className="lead" style={{ marginBottom: 0 }}>
            Messages labeled INBOX
          </p>
        </div>
        <Link to="/compose" className="btn btn-primary">
          Compose
        </Link>
      </div>

      {error && <div className="status-banner error">{error}</div>}

      {loading ? (
        <div className="center-state" style={{ minHeight: '20vh' }}>
          <div className="spinner" />
        </div>
      ) : messages.length === 0 ? (
        <p className="lead">Your inbox is empty.</p>
      ) : (
        <ul className="message-list">
          {messages.map((msg) => (
            <li key={msg.id}>
              <Link
                to={`/inbox/${msg.id}`}
                className={`message-row${msg.isRead ? '' : ' unread'}`}
              >
                <div className="meta">
                  <span>{msg.from?.name || msg.from?.email || 'Unknown'}</span>
                  <span>{formatDate(msg.sentDate)}</span>
                </div>
                <div className="subject">{msg.subject || '(no subject)'}</div>
                {msg.preview && <p className="preview">{msg.preview}</p>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
