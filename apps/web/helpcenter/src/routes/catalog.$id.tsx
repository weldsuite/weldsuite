import { Link, createFileRoute, redirect } from '@tanstack/react-router'
import { getCatalogItem } from '@/lib/portal'
import { fill, usePortalStrings } from '@/lib/portal-i18n'
import { pageTitle } from '@/lib/site'
import { PortalError, PortalPage } from '@/components/portal/PortalShell'
import { RequestForm } from '@/components/portal/RequestForm'

export const Route = createFileRoute('/catalog/$id')({
  loader: async ({ params, location }) => {
    const result = await getCatalogItem({ data: { id: params.id } })
    if (!result.signedIn) throw redirect({ to: '/sign-in', search: { next: location.href } })
    return result.data
  },
  head: ({ loaderData, matches }) => ({
    meta: [{ title: pageTitle(matches, loaderData?.name || 'Service catalogue') }, { name: 'robots', content: 'noindex' }],
  }),
  errorComponent: PortalError,
  component: CatalogItemPage,
})

function CatalogItemPage() {
  return (
    <PortalPage>
      <CatalogItem />
    </PortalPage>
  )
}

function CatalogItem() {
  const t = usePortalStrings()
  const item = Route.useLoaderData()

  return (
    <>
      <Link
        to="/catalog"
        className="inline-flex items-center gap-1 text-sm text-zinc-500 transition-colors hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
      >
        <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m10 4-4 4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {t.catalog.back}
      </Link>

      <header className="mt-4">
        <h1 className="text-3xl font-semibold tracking-tight break-words text-zinc-900 dark:text-white">{item.name}</h1>
        {item.summary && <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">{item.summary}</p>}
        {(item.deliveryEstimate || item.needsApproval) && (
          <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
            {item.deliveryEstimate ? fill(t.catalog.delivery, { estimate: item.deliveryEstimate }) : ''}
            {item.deliveryEstimate && item.needsApproval ? ' · ' : ''}
            {item.needsApproval ? t.catalog.needsApproval : ''}
          </p>
        )}
      </header>

      {item.description && (
        <p className="mt-6 text-sm leading-relaxed break-words whitespace-pre-wrap text-zinc-700 dark:text-zinc-300">
          {item.description}
        </p>
      )}

      <div className="mt-8">
        <RequestForm key={item.id} type={item.form} catalogItem={{ id: item.id, name: item.name }} />
      </div>
    </>
  )
}
