import { useState } from 'react'
import { Link, createFileRoute, redirect } from '@tanstack/react-router'
import clsx from 'clsx'
import type { DeskPortalRequestSummary } from '@weldsuite/app-api-client/schemas/desk-portal'
import { getMyRequests, type RequestsPage } from '@/lib/portal'
import { fill, useDateFormat, usePortalStrings } from '@/lib/portal-i18n'
import { useSignInRedirect } from '@/lib/portal-nav'
import { pageTitle } from '@/lib/site'
import { PortalError, PortalPage } from '@/components/portal/PortalShell'
import { StatusBadge } from '@/components/portal/StatusBadge'
import { primaryButtonClass, secondaryButtonClass } from '@/components/portal/styles'

type Tab = 'open' | 'closed'

export const Route = createFileRoute('/requests/')({
  validateSearch: (search: Record<string, unknown>): { status?: Tab } =>
    search.status === 'closed' ? { status: 'closed' } : {},
  loaderDeps: ({ search }) => ({ status: search.status ?? ('open' as Tab) }),
  loader: async ({ deps, location }) => {
    const result = await getMyRequests({ data: { status: deps.status } })
    if (!result.signedIn) throw redirect({ to: '/sign-in', search: { next: location.href } })
    return result.data
  },
  head: ({ matches }) => ({
    meta: [{ title: pageTitle(matches, 'My requests') }, { name: 'robots', content: 'noindex' }],
  }),
  errorComponent: PortalError,
  component: MyRequestsPage,
})

function MyRequestsPage() {
  const page = Route.useLoaderData()
  const { status } = Route.useLoaderDeps()
  return (
    <PortalPage>
      {/* Keyed so "load more" state resets when the tab or the first page changes. */}
      <MyRequests key={`${status}:${page.requests[0]?.id ?? ''}:${page.cursor ?? ''}`} first={page} status={status} />
    </PortalPage>
  )
}

function MyRequests({ first, status }: Readonly<{ first: RequestsPage; status: Tab }>) {
  const t = usePortalStrings()
  const toSignIn = useSignInRedirect()
  const [requests, setRequests] = useState(first.requests)
  const [cursor, setCursor] = useState(first.hasMore ? first.cursor : null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  const loadMore = async () => {
    if (!cursor || loading) return
    setLoading(true)
    setFailed(false)
    try {
      const result = await getMyRequests({ data: { status, cursor } })
      if (!result.signedIn) {
        toSignIn()
        return
      }
      setRequests((prev) => [...prev, ...result.data.requests.filter((r) => !prev.some((p) => p.id === r.id))])
      setCursor(result.data.hasMore ? result.data.cursor : null)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'open', label: t.requests.open },
    { key: 'closed', label: t.requests.closed },
  ]

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-white">{t.requests.title}</h1>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">{t.requests.intro}</p>
        </div>
        <Link to="/requests/new" className={primaryButtonClass}>
          {t.submitRequest}
        </Link>
      </div>

      <nav className="mt-8 flex gap-1 border-b border-zinc-200 dark:border-zinc-800" aria-label={t.requests.title}>
        {tabs.map((tab) => (
          <Link
            key={tab.key}
            to="/requests"
            search={tab.key === 'closed' ? { status: 'closed' } : {}}
            aria-current={tab.key === status ? 'page' : undefined}
            className={clsx(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              tab.key === status
                ? 'border-[var(--hc-accent)] text-zinc-900 dark:text-white'
                : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
            )}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {requests.length === 0 ? (
        <p className="py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">
          {status === 'open' ? t.requests.emptyOpen : t.requests.emptyClosed}
        </p>
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
          {requests.map((request) => (
            <li key={request.id}>
              <RequestRow request={request} />
            </li>
          ))}
        </ul>
      )}

      {cursor && (
        <div className="mt-6 text-center">
          <button type="button" onClick={() => void loadMore()} disabled={loading} className={secondaryButtonClass}>
            {loading ? t.requests.loading : t.requests.loadMore}
          </button>
          {failed && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{t.errors.generic}</p>}
        </div>
      )}
    </>
  )
}

function RequestRow({ request }: Readonly<{ request: DeskPortalRequestSummary }>) {
  const t = usePortalStrings()
  const { date } = useDateFormat()
  return (
    <Link to="/requests/$id" params={{ id: request.id }} className="group flex items-start gap-4 py-4">
      <span className="min-w-0 flex-auto">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-zinc-900 group-hover:text-[var(--hc-accent)] dark:text-white">
            {request.title || t.requests.untitled}
          </span>
          <StatusBadge status={request.status} label={request.statusLabel} t={t} />
        </span>
        {request.lastMessagePreview && (
          <span className="mt-1 line-clamp-1 block text-sm text-zinc-500 dark:text-zinc-400">
            {request.lastMessagePreview}
          </span>
        )}
        <span className="mt-1 block text-xs text-zinc-400 dark:text-zinc-500">
          {fill(t.requests.number, { number: request.number })}
          {request.typeName ? ` · ${request.typeName}` : ''}
          {' · '}
          <time dateTime={request.updatedAt} suppressHydrationWarning>
            {fill(t.requests.updated, { date: date(request.updatedAt) })}
          </time>
        </span>
      </span>
      <svg
        className="mt-1 h-4 w-4 shrink-0 text-zinc-300 transition-transform group-hover:translate-x-0.5 group-hover:text-[var(--hc-accent)] dark:text-zinc-600"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Link>
  )
}
