import { FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { MailAccount } from '@weldsuite/personal-api-client';
import { personalApi } from '@/lib/api';

export function ComposePage() {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [accountId, setAccountId] = useState('');
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void personalApi.mailAccounts
      .list()
      .then(({ data }) => {
        setAccounts(data);
        const def = data.find((a) => a.isDefault) ?? data[0];
        if (def) setAccountId(def.id);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load accounts');
      });
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!accountId || !to.trim()) {
      setError('Choose an account and recipient');
      return;
    }
    setSending(true);
    setError(null);
    try {
      await personalApi.mailMessages.send({
        accountId,
        to: to.trim(),
        subject: subject.trim(),
        textBody: body,
      });
      navigate('/inbox');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="panel">
      <h1>Compose</h1>
      <p className="lead">Send from your WeldMail address</p>

      {error && <div className="status-banner error">{error}</div>}

      <form onSubmit={onSubmit}>
        {accounts.length > 1 && (
          <div className="field">
            <label htmlFor="from">From</label>
            <select
              id="from"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              style={{
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '0.65rem 0.75rem',
              }}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.email}
                </option>
              ))}
            </select>
          </div>
        )}
        {accounts.length === 1 && (
          <p className="lead" style={{ fontSize: '0.9rem' }}>
            From {accounts[0]?.email}
          </p>
        )}

        <div className="field">
          <label htmlFor="to">To</label>
          <input
            id="to"
            type="email"
            required
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="recipient@example.com"
          />
        </div>

        <div className="field">
          <label htmlFor="subject">Subject</label>
          <input
            id="subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
          />
        </div>

        <div className="field">
          <label htmlFor="body">Message</label>
          <textarea
            id="body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write your message…"
          />
        </div>

        <button type="submit" className="btn btn-primary" disabled={sending || !accountId}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </form>
    </div>
  );
}
