import { Suspense, useEffect, useState } from 'react'
import clsx from 'clsx'
import type { Announcement } from '@/lib/api-client'
import { useSelfServiceStrings } from '@/lib/portal-i18n'
import { LinkifiedText } from '@/components/LinkifiedText'

/** Ids of the banners this browser closed. */
const STORAGE_KEY = 'hc_dismissed_announcements'
/** Enough for every banner a help center shows at once; older ids fall off. */
const MAX_REMEMBERED = 100

function readDismissed(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function writeDismissed(ids: string[]): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(ids.slice(-MAX_REMEMBERED)))
  } catch {
    // Private mode or storage blocked: the banner closes for this page only.
  }
}

const TONES: Record<string, { box: string; icon: string }> = {
  info: {
    box: 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-100',
    icon: 'text-sky-600 dark:text-sky-300',
  },
  warning: {
    box: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100',
    icon: 'text-amber-600 dark:text-amber-300',
  },
  success: {
    box: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100',
    icon: 'text-emerald-600 dark:text-emerald-300',
  },
  error: {
    box: 'border-red-200 bg-red-50 text-red-900 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100',
    icon: 'text-red-600 dark:text-red-300',
  },
}

function toneOf(type: string) {
  return TONES[type] ?? TONES.info
}

function TypeIcon({ type, className }: Readonly<{ type: string; className: string }>) {
  const common = { className: clsx('mt-0.5 h-4 w-4 shrink-0', className), viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true } as const
  if (type === 'success') {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
        <path d="m5.5 8.2 1.7 1.7 3.3-3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (type === 'warning' || type === 'error') {
    return (
      <svg {...common}>
        <path d="M8 2.2 14.3 13H1.7L8 2.2Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M8 6.5v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="8" cy="11.3" r=".8" fill="currentColor" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 7.3v3.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="5" r=".8" fill="currentColor" />
    </svg>
  )
}

function DismissButton({ onDismiss }: Readonly<{ onDismiss: () => void }>) {
  const t = useSelfServiceStrings()
  return (
    <button
      type="button"
      onClick={onDismiss}
      aria-label={t.dismiss}
      title={t.dismiss}
      className="-m-1 shrink-0 rounded-md p-1 opacity-70 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
    >
      <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="m4.5 4.5 7 7m0-7-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
  )
}

/**
 * The status banners under the header, in the order desk-api sends them
 * (pinned first). Each can be closed; this browser then leaves it closed.
 * The server renders every banner, and the ones closed before drop out once
 * the page is live (localStorage is browser-only).
 */
export function AnnouncementBanners({ announcements }: Readonly<{ announcements: Announcement[] }>) {
  const [dismissed, setDismissed] = useState<string[]>([])

  useEffect(() => {
    setDismissed(readDismissed())
  }, [])

  const shown = announcements.filter((a) => !dismissed.includes(a.id))
  if (shown.length === 0) return null

  const dismiss = (id: string) => {
    const next = [...readDismissed().filter((known) => known !== id), id]
    writeDismissed(next)
    setDismissed(next)
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-2 px-4 pt-4 sm:px-6 lg:px-8" data-testid="hc-announcements">
      {shown.map((announcement) => {
        const tone = toneOf(announcement.type)
        const text = announcement.content.trim() || announcement.excerpt?.trim() || ''
        return (
          <div
            key={announcement.id}
            role={announcement.type === 'error' || announcement.type === 'warning' ? 'alert' : 'status'}
            className={clsx('flex items-start gap-3 rounded-xl border px-4 py-3 text-sm', tone.box)}
          >
            <TypeIcon type={announcement.type} className={tone.icon} />
            <div className="min-w-0 flex-auto">
              <p className="font-semibold">{announcement.title}</p>
              {text && (
                <p className="mt-0.5 break-words whitespace-pre-wrap opacity-90">
                  <LinkifiedText text={text} />
                </p>
              )}
            </div>
            <Suspense fallback={null}>
              <DismissButton onDismiss={() => dismiss(announcement.id)} />
            </Suspense>
          </div>
        )
      })}
    </div>
  )
}
