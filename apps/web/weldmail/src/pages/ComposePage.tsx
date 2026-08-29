import { FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { MailAccount } from '@weldsuite/personal-api-client';
import { personalApi } from '@/lib/api';

const fieldClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40';
const labelClass = 'mb-1.5 block text-xs font-medium text-muted-foreground';

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
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[53px] shrink-0 items-center border-b border-border px-4">
        <h1 className="text-sm font-semibold text-foreground">Compose</h1>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <p className="mb-5 text-sm text-muted-foreground">Send from your WeldMail address</p>

        {error && (
          <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <form onSubmit={onSubmit} className="max-w-xl space-y-4">
          {accounts.length > 1 && (
            <div>
              <label htmlFor="from" className={labelClass}>
                From
              </label>
              <select
                id="from"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className={fieldClass}
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
            <p className="text-sm text-muted-foreground">From {accounts[0]?.email}</p>
          )}

          <div>
            <label htmlFor="to" className={labelClass}>
              To
            </label>
            <input
              id="to"
              type="email"
              required
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="recipient@example.com"
              className={fieldClass}
            />
          </div>

          <div>
            <label htmlFor="subject" className={labelClass}>
              Subject
            </label>
            <input
              id="subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              className={fieldClass}
            />
          </div>

          <div>
            <label htmlFor="body" className={labelClass}>
              Message
            </label>
            <textarea
              id="body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your message…"
              rows={10}
              className={`${fieldClass} min-h-[160px] resize-y`}
            />
          </div>

          <button
            type="submit"
            disabled={sending || !accountId}
            className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </form>
      </div>
    </div>
  );
}
