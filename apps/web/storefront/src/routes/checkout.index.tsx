import { createFileRoute } from '@tanstack/react-router'
import { CheckoutPage } from '@/components/checkout/checkout-page'
import { listingSearch } from '@/lib/search'
import { headTags } from '@/lib/seo'
import { getCheckoutPage } from '@/lib/server/loaders/checkout'

export const Route = createFileRoute('/checkout/')({
  validateSearch: listingSearch,
  loader: () => getCheckoutPage(),
  head: ({ loaderData }) => headTags(loaderData?.head),
  component: Checkout,
})

function Checkout() {
  return <CheckoutPage view={Route.useLoaderData()} />
}
