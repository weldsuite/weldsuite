import { createFileRoute } from '@tanstack/react-router'
import { TemplateView } from '@/components/template-view'
import { listingSearch } from '@/lib/search'
import { headTags } from '@/lib/seo'
import { getCartPage } from '@/lib/server/loaders/catalogue'

export const Route = createFileRoute('/cart')({
  validateSearch: listingSearch,
  loader: () => getCartPage(),
  head: ({ loaderData }) => headTags(loaderData?.head),
  component: CartPage,
})

function CartPage() {
  return <TemplateView page={Route.useLoaderData()} />
}
