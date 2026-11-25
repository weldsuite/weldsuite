import { createFileRoute } from '@tanstack/react-router'
import { OrderView } from '@/components/account/order-view'
import { segment } from '@/lib/paths'
import { param } from '@/lib/search'
import { headTags } from '@/lib/seo'
import { getGuestOrder } from '@/lib/server/loaders/checkout'

/** A guest's order: the link in the confirmation email (the channel's `orderUrl`). */
export const Route = createFileRoute('/orders/$id')({
  validateSearch: (search: Record<string, unknown>) => ({ token: param(search, 'token', 200) }),
  loaderDeps: ({ search }) => ({ token: search.token }),
  loader: ({ params, deps }) => getGuestOrder({ data: { id: segment(params.id), token: deps.token } }),
  head: ({ loaderData }) => ({
    ...headTags(loaderData?.head),
    // The order token is in the URL: never send it on.
    meta: [...headTags(loaderData?.head).meta, { name: 'referrer', content: 'no-referrer' }],
  }),
  component: GuestOrder,
})

function GuestOrder() {
  const { order } = Route.useLoaderData()
  return (
    <div className="shop-container shop-section">
      <OrderView order={order} />
    </div>
  )
}
