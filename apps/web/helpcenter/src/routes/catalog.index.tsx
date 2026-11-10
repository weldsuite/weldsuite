import { Link, createFileRoute, redirect } from '@tanstack/react-router'
import type { DeskPortalCatalogItem } from '@weldsuite/app-api-client/schemas/desk-portal'
import { getCatalog } from '@/lib/portal'
import { fill, usePortalStrings } from '@/lib/portal-i18n'
import { pageTitle } from '@/lib/site'
import { PortalError, PortalPage } from '@/components/portal/PortalShell'
import { cardClass } from '@/components/portal/styles'

export const Route = createFileRoute('/catalog/')({
  loader: async ({ location }) => {
    const result = await getCatalog()
    if (!result.signedIn) throw redirect({ to: '/sign-in', search: { next: location.href } })
    return result.data
  },
  head: ({ matches }) => ({
    meta: [{ title: pageTitle(matches, 'Service catalogue') }, { name: 'robots', content: 'noindex' }],
  }),
  errorComponent: PortalError,
  component: CatalogPage,
})

function CatalogPage() {
  return (
    <PortalPage>
      <Catalog />
    </PortalPage>
  )
}

/** The items grouped by category, in the order the server sent them (category, sort order, name). */
function groupByCategory(items: DeskPortalCatalogItem[]): Array<{ category: string | null; items: DeskPortalCatalogItem[] }> {
  const groups: Array<{ category: string | null; items: DeskPortalCatalogItem[] }> = []
  for (const item of items) {
    const group = groups.find((g) => g.category === item.category)
    if (group) group.items.push(item)
    else groups.push({ category: item.category, items: [item] })
  }
  return groups
}

function Catalog() {
  const t = usePortalStrings()
  const items = Route.useLoaderData()
  const groups = groupByCategory(items)

  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-white">{t.catalog.title}</h1>
      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">{t.catalog.intro}</p>

      {items.length === 0 && <p className="mt-10 text-sm text-zinc-500 dark:text-zinc-400">{t.catalog.empty}</p>}

      <div className="mt-8 space-y-10">
        {groups.map((group, index) => {
          const headingId = `hc-catalog-group-${index}`
          return (
            <section key={group.category ?? '__other'} aria-labelledby={headingId}>
              <h2 id={headingId} className="text-base font-semibold text-zinc-900 dark:text-white">
                {group.category ?? t.catalog.otherCategory}
              </h2>
              <ul className="mt-4 grid gap-3 sm:grid-cols-2">
                {group.items.map((item) => (
                  <li key={item.id}>
                    <Link
                      to="/catalog/$id"
                      params={{ id: item.id }}
                      className={`${cardClass} group flex h-full items-start gap-3 p-4 transition-all hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-md dark:hover:border-zinc-700`}
                    >
                      <span
                        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-sm font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                        aria-hidden="true"
                      >
                        {item.name.trim().charAt(0).toUpperCase()}
                      </span>
                      <span className="min-w-0">
                        <span className="block font-medium text-zinc-900 group-hover:text-[var(--hc-accent)] dark:text-white">
                          {item.name}
                        </span>
                        {item.summary && (
                          <span className="mt-1 line-clamp-2 block text-sm text-zinc-500 dark:text-zinc-400">
                            {item.summary}
                          </span>
                        )}
                        {(item.deliveryEstimate || item.needsApproval) && (
                          <span className="mt-2 block text-xs text-zinc-400 dark:text-zinc-500">
                            {item.deliveryEstimate ? fill(t.catalog.delivery, { estimate: item.deliveryEstimate }) : ''}
                            {item.deliveryEstimate && item.needsApproval ? ' · ' : ''}
                            {item.needsApproval ? t.catalog.needsApproval : ''}
                          </span>
                        )}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </>
  )
}
