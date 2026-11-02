import { Link, createFileRoute, redirect } from '@tanstack/react-router'
import { getRequestDetail } from '@/lib/portal'
import { fill, useDateFormat, usePortalStrings } from '@/lib/portal-i18n'
import { pageTitle } from '@/lib/site'
import { PortalError, PortalPage } from '@/components/portal/PortalShell'
import { ReplyBox, RequestThread } from '@/components/portal/RequestThread'
import { StatusBadge } from '@/components/portal/StatusBadge'

export const Route = createFileRoute('/requests/$id')({
  loader: async ({ params, location }) => {
    const result = await getRequestDetail({ data: { id: params.id } })
    if (!result.signedIn) throw redirect({ to: '/sign-in', search: { next: location.href } })
    return result.data
  },
  head: ({ loaderData, matches }) => ({
    meta: [
      { title: pageTitle(matches, loaderData?.title || (loaderData ? `#${loaderData.number}` : 'Request')) },
      { name: 'robots', content: 'noindex' },
    ],
  }),
  errorComponent: PortalError,
  component: RequestPage,
})

function RequestPage() {
  return (
    <PortalPage>
      <RequestView />
    </PortalPage>
  )
}

function RequestView() {
  const t = usePortalStrings()
  const { date } = useDateFormat()
  const request = Route.useLoaderData()

  return (
    <>
      <Link
        to="/requests"
        className="inline-flex items-center gap-1 text-sm text-zinc-500 transition-colors hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
      >
        <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m10 4-4 4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {t.request.back}
      </Link>

      <header className="mt-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="min-w-0 text-2xl font-semibold tracking-tight break-words text-zinc-900 sm:text-3xl dark:text-white">
            {request.title || t.requests.untitled}
          </h1>
          <StatusBadge status={request.status} label={request.statusLabel} t={t} />
        </div>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          {fill(t.requests.number, { number: request.number })}
          {request.typeName ? ` · ${request.typeName}` : ''}
          {' · '}
          <time dateTime={request.createdAt} suppressHydrationWarning>
            {fill(t.request.submittedOn, { date: date(request.createdAt) })}
          </time>
        </p>
      </header>

      {request.fields.length > 0 && (
        <section className="mt-8" aria-labelledby="hc-details-heading">
          <h2 id="hc-details-heading" className="text-sm font-semibold text-zinc-900 dark:text-white">
            {t.request.details}
          </h2>
          <dl className="mt-3 divide-y divide-zinc-100 rounded-xl border border-zinc-200 dark:divide-zinc-800/70 dark:border-zinc-800">
            {request.fields.map((field) => (
              <div key={field.key} className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-3 sm:gap-4">
                <dt className="text-zinc-500 dark:text-zinc-400">{field.label}</dt>
                <dd className="break-words whitespace-pre-wrap text-zinc-900 sm:col-span-2 dark:text-zinc-100">
                  {field.value}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <section className="mt-10" aria-labelledby="hc-thread-heading">
        <h2 id="hc-thread-heading" className="text-sm font-semibold text-zinc-900 dark:text-white">
          {t.request.conversation}
        </h2>
        <div className="mt-4">
          <RequestThread messages={request.messages} />
        </div>
      </section>

      <section className="mt-10 border-t border-zinc-200 pt-8 dark:border-zinc-800">
        <ReplyBox request={request} />
      </section>
    </>
  )
}
