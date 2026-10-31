import { useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import clsx from 'clsx'
import type { DeskPortalMessage, DeskPortalRequestDetail } from '@weldsuite/app-api-client/schemas/desk-portal'
import { replyToRequest } from '@/lib/portal'
import { errorText, useDateFormat, usePortalStrings, type PortalStrings } from '@/lib/portal-i18n'
import { BODY_MAX } from '@/lib/portal-fields'
import { useSignInRedirect } from '@/lib/portal-nav'
import { fieldErrorClass, inputClass, invalidInputClass, labelClass, primaryButtonClass } from '@/components/portal/styles'

/** Only http(s) links and images from the thread; anything else is dropped. */
function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null
  } catch {
    return null
  }
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** The shown events: closed and reopened. Other events stay with the team's timeline. */
function eventLabel(message: DeskPortalMessage, t: PortalStrings): string | null {
  if (message.eventType === 'closed') return t.request.closedEvent
  if (message.eventType === 'reopened') return t.request.reopenedEvent
  return null
}

function Avatar({ message, t }: Readonly<{ message: DeskPortalMessage; t: PortalStrings }>) {
  const src = safeUrl(message.authorAvatar)
  const name = message.authorType === 'visitor' ? t.request.you : message.authorName || t.request.support
  if (src) {
    return <img src={src} alt="" width={32} height={32} className="h-8 w-8 shrink-0 rounded-full object-cover" />
  }
  return (
    <span
      aria-hidden="true"
      className={clsx(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
        message.authorType === 'visitor'
          ? 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200'
          : 'bg-[var(--hc-accent)] text-white',
      )}
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  )
}

function Message({ message, t }: Readonly<{ message: DeskPortalMessage; t: PortalStrings }>) {
  const { dateTime } = useDateFormat()
  const mine = message.authorType === 'visitor'
  const name = mine ? t.request.you : message.authorName || t.request.support
  const attachments = (message.attachments ?? []).filter((a) => safeUrl(a.url))

  return (
    <li className="flex gap-3">
      <Avatar message={message} t={t} />
      <div className="min-w-0 flex-auto">
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-medium text-zinc-900 dark:text-white">{name}</span>
          <time dateTime={message.createdAt} className="text-xs text-zinc-400 dark:text-zinc-500" suppressHydrationWarning>
            {dateTime(message.createdAt)}
          </time>
        </p>
        <div
          className={clsx(
            'mt-1.5 rounded-xl px-4 py-3 text-sm',
            mine
              ? 'bg-zinc-50 text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200'
              : 'border border-zinc-200 bg-white text-zinc-800 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200',
          )}
        >
          {message.body && <p className="break-words whitespace-pre-wrap">{message.body}</p>}
          {attachments.length > 0 && (
            <ul className={clsx('flex flex-wrap gap-2', message.body && 'mt-3')}>
              {attachments.map((a, i) => (
                <li key={`${a.url}-${i}`}>
                  <a
                    href={safeUrl(a.url) ?? undefined}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1 text-xs text-zinc-700 transition-colors hover:border-[var(--hc-accent)] hover:text-[var(--hc-accent)] dark:border-zinc-700 dark:text-zinc-300"
                  >
                    <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path
                        d="m10.5 5-4.8 4.8a1.4 1.4 0 0 0 2 2L13 6.5a2.8 2.8 0 0 0-4-4L3.7 7.8a4.2 4.2 0 0 0 6 6L14 9.5"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span className="truncate">{a.name}</span>
                    {formatSize(a.filesize) && <span className="shrink-0 text-zinc-400">{formatSize(a.filesize)}</span>}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </li>
  )
}

/** The public thread, oldest first, with closed/reopened shown as small system lines. */
export function RequestThread({ messages }: Readonly<{ messages: DeskPortalMessage[] }>) {
  const t = usePortalStrings()
  const { dateTime } = useDateFormat()
  const ordered = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  return (
    <ol className="space-y-6">
      {ordered.map((message) => {
        if (message.kind === 'event') {
          const label = eventLabel(message, t)
          if (!label) return null
          return (
            <li key={message.id} className="flex items-center gap-3 text-xs text-zinc-400 dark:text-zinc-500">
              <span className="h-px flex-auto bg-zinc-200 dark:bg-zinc-800" aria-hidden="true" />
              <span>
                {label} ·{' '}
                <time dateTime={message.createdAt} suppressHydrationWarning>
                  {dateTime(message.createdAt)}
                </time>
              </span>
              <span className="h-px flex-auto bg-zinc-200 dark:bg-zinc-800" aria-hidden="true" />
            </li>
          )
        }
        if (!message.body && !message.attachments?.length) return null
        return <Message key={message.id} message={message} t={t} />
      })}
    </ol>
  )
}

/** Reply box. A reply to a resolved request reopens it, which the box says. */
export function ReplyBox({ request }: Readonly<{ request: DeskPortalRequestDetail }>) {
  const t = usePortalStrings()
  const router = useRouter()
  const toSignIn = useSignInRedirect()
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = async () => {
    const text = body.trim()
    if (!text) {
      setError(t.errors.required)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await replyToRequest({ data: { id: request.id, body: text } })
      if (!result.ok) {
        if (result.code === 'SIGN_IN_REQUIRED') {
          toSignIn()
          return
        }
        setError(result.field === 'body' ? t.errors.invalidField : errorText(t, result.code))
        return
      }
      setBody('')
      // Reload the request: the new message, and the status it moved to.
      await router.invalidate()
    } catch {
      setError(t.errors.generic)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
    >
      <label htmlFor="hc-reply" className={labelClass}>
        {t.request.replyLabel}
      </label>
      {request.status === 'resolved' && (
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{t.request.reopenNotice}</p>
      )}
      <textarea
        id="hc-reply"
        rows={4}
        value={body}
        maxLength={BODY_MAX}
        onChange={(e) => {
          setBody(e.target.value)
          if (error) setError(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void send()
          }
        }}
        placeholder={t.request.replyPlaceholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'hc-reply-error' : undefined}
        className={`${inputClass} mt-2 ${error ? invalidInputClass : ''}`}
      />
      {error && (
        <p id="hc-reply-error" role="alert" className={fieldErrorClass}>
          {error}
        </p>
      )}
      <div className="mt-3 flex justify-end">
        <button type="submit" disabled={busy || !body.trim()} className={primaryButtonClass}>
          {busy ? t.request.sending : t.request.send}
        </button>
      </div>
    </form>
  )
}
