import { createFileRoute } from '@tanstack/react-router'
import { ReturnPage } from '@/components/checkout/return-page'
import { param } from '@/lib/search'
import { headTags } from '@/lib/seo'
import { getCheckoutReturn } from '@/lib/server/loaders/checkout'

/** Where Mollie sends the shopper back: `?order=<orderId>&payment=<paymentId>`. */
export const Route = createFileRoute('/checkout/return')({
  validateSearch: (search: Record<string, unknown>) => ({
    order: param(search, 'order', 100),
    payment: param(search, 'payment', 100),
    error: param(search, 'error', 60),
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getCheckoutReturn({ data: deps }),
  head: ({ loaderData }) => ({
    ...headTags(loaderData?.head),
    // The order and payment ids are in the URL: never send them on.
    meta: [...headTags(loaderData?.head).meta, { name: 'referrer', content: 'no-referrer' }],
  }),
  component: Return,
})

function Return() {
  return <ReturnPage view={Route.useLoaderData()} />
}
