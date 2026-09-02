import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CornerUpLeft, CornerUpRight, Paperclip, ReplyAll } from 'lucide-react';
import type { MailAttachment, MailMessage } from '@weldsuite/personal-api-client';
import { personalApi } from '@/lib/api';
import { MessageBody } from '@/components/message-body';
import { useMailEvents } from '@/contexts/mail-events';
import { cn } from '@/lib/utils';

type ComposeMode = 'reply' | 'replyAll' | 'forward';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function addressLine(msg: MailMessage): string {
  return (msg.to ?? []).map((a) => a.name || a.email).join(', ');
}

export function MessagePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { adjustUnreadCount, refreshUnreadCount } = useMailEvents();

  const [message, setMessage] = useState<MailMessage | null>(null);
  const [attachments, setAttachments] = useState<MailAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<ComposeMode | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const [forwardTo, setForwardTo] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sentNotice, setSentNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    async function load(messageId: string) {
      setLoading(true);
      setError(null);
      setMode(null);
      setSentNotice(null);
      try {
        const { data } = await personalApi.mailMessages.get(messageId);
        if (cancelled) return;
        setMessage(data);

        if (!data.isRead) {
          // Drop the badge straight away, then reconcile with the server —
          // waiting for the round-trip leaves a stale count on screen.
          adjustUnreadCount(-1);
          const { data: updated } = await personalApi.mailMessages.patch(messageId, {
            isRead: true,
          });
          if (!cancelled) setMessage(updated);
          void refreshUnreadCount();
        }

        if (data.hasAttachments) {
          const { data: files } = await personalApi.mailMessages.attachments(messageId);
          if (!cancelled) setAttachments(files);
        } else if (!cancelled) {
          setAttachments([]);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load message');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load(id);
    return () => {
      cancelled = true;
    };
  }, [id, adjustUnreadCount, refreshUnreadCount]);

  const startCompose = useCallback((next: ComposeMode) => {
    setMode(next);
    setSendError(null);
    setSentNotice(null);
  }, []);

  async function onSend() {
    if (!id || !mode) return;
    setSending(true);
    setSendError(null);
    try {
      if (mode === 'forward') {
        if (!forwardTo.trim()) {
          setSendError('Enter a recipient to forward to');
          return;
        }
        await personalApi.mailMessages.forward(id, {
          to: forwardTo.trim(),
          textBody: replyBody,
        });
        setSentNotice('Message forwarded.');
      } else {
        await personalApi.mailMessages.reply(id, {
          textBody: replyBody,
          replyAll: mode === 'replyAll',
        });
        setSentNotice('Reply sent.');
      }
      setMode(null);
      setReplyBody('');
      setForwardTo('');
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setSending(false);
    }
  }

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

  const actionClass =
    'inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[53px] shrink-0 items-center gap-2 border-b border-border px-4">
        <Link
          to="/inbox"
          className="inline-flex h-8 items-center rounded-md border border-border px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          ← Inbox
        </Link>
        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={() => startCompose('reply')} className={actionClass}>
            <CornerUpLeft className="h-4 w-4" />
            Reply
          </button>
          <button type="button" onClick={() => startCompose('replyAll')} className={actionClass}>
            <ReplyAll className="h-4 w-4" />
            Reply all
          </button>
          <button type="button" onClick={() => startCompose('forward')} className={actionClass}>
            <CornerUpRight className="h-4 w-4" />
            Forward
          </button>
        </div>
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
        {addressLine(message) && (
          <p className="text-sm text-muted-foreground">To {addressLine(message)}</p>
        )}

        <div className="mt-6">
          <MessageBody htmlBody={message.htmlBody} textBody={message.textBody} />
        </div>

        {attachments.length > 0 && (
          <div className="mt-6 border-t border-border pt-4">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {attachments.length} attachment{attachments.length === 1 ? '' : 's'}
            </p>
            <ul className="flex flex-wrap gap-2">
              {attachments.map((file) => {
                const inner = (
                  <>
                    <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{file.fileName}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatBytes(file.size)}
                    </span>
                  </>
                );
                return (
                  <li key={file.id}>
                    {file.downloadUrl ? (
                      <a
                        href={file.downloadUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="flex max-w-[240px] items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm text-foreground hover:bg-muted"
                      >
                        {inner}
                      </a>
                    ) : (
                      <span className="flex max-w-[240px] items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm text-muted-foreground">
                        {inner}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {sentNotice && (
          <div className="mt-6 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
            {sentNotice}
          </div>
        )}

        {mode && (
          <div className="mt-6 rounded-lg border border-border p-4">
            <p className="mb-3 text-sm font-medium text-foreground">
              {mode === 'forward'
                ? 'Forward'
                : mode === 'replyAll'
                  ? 'Reply all'
                  : `Reply to ${message.from?.name || message.from?.email}`}
            </p>

            {sendError && (
              <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {sendError}
              </div>
            )}

            {mode === 'forward' && (
              <input
                type="email"
                value={forwardTo}
                onChange={(e) => setForwardTo(e.target.value)}
                placeholder="recipient@example.com"
                className="mb-3 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              />
            )}

            <textarea
              value={replyBody}
              onChange={(e) => setReplyBody(e.target.value)}
              rows={8}
              placeholder={mode === 'forward' ? 'Add a note…' : 'Write your reply…'}
              className="w-full min-h-[140px] resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            />

            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void onSend()}
                disabled={sending}
                className={cn(
                  'inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90',
                  sending && 'opacity-50',
                )}
              >
                {sending ? 'Sending…' : 'Send'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode(null);
                  setSendError(null);
                }}
                className="inline-flex h-9 items-center rounded-md border border-border px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => navigate('/inbox')}
                className="ml-auto text-sm text-muted-foreground hover:text-foreground"
              >
                Back to inbox
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
