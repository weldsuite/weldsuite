import { createFileRoute } from '@tanstack/react-router'
import { ShopLink, useShop } from '@weldsuite/storefront-theme'
import { OrdersTable } from '@/components/account/order-view'
import { param } from '@/lib/search'
import { withQuery } from '@/lib/paths'
import { headTags } from '@/lib/seo'
import { getOrdersPage } from '@/lib/server/loaders/account'

export const Route = createFileRoute('/account/orders/')({
  validateSearch: (search: Record<string, unknown>) => ({ cursor: param(search, 'cursor', 500) }),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getOrdersPage({ data: deps }),
  head: ({ loaderData }) => headTags(loaderData?.head),
  component: Orders,
})

function Orders() {
  const { page, cursor } = Route.useLoaderData()
  const { shop } = useShop()
  const s = shop.strings
  return (
    <div className="shop-container shop-section flex flex-col gap-6">
      <h1 className="text-3xl font-semibold md:text-4xl">{s.account.orders}</h1>
      {page.data.length > 0 ? <OrdersTable orders={page.data} /> : <p>{s.account.noOrders}</p>}
      <nav aria-label={s.account.orders} className="flex flex-wrap gap-3">
        {cursor ? (
          <ShopLink href="/account/orders" className="shop-btn shop-btn-secondary">
            {s.listing.firstPage}
          </ShopLink>
        ) : null}
        {page.pagination.hasMore && page.pagination.cursor ? (
          <ShopLink href={withQuery('/account/orders', { cursor: page.pagination.cursor })} className="shop-btn shop-btn-secondary">
            {s.common.next}
          </ShopLink>
        ) : null}
      </nav>
    </div>
  )
}
