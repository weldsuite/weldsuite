import { createFileRoute } from '@tanstack/react-router'
import { TemplateView } from '@/components/template-view'
import { segment } from '@/lib/paths'
import { listingSearch } from '@/lib/search'
import { headTags } from '@/lib/seo'
import { getProductPage } from '@/lib/server/loaders/catalogue'

export const Route = createFileRoute('/products/$slug')({
  validateSearch: listingSearch,
  loader: ({ params }) => getProductPage({ data: { slug: segment(params.slug) } }),
  head: ({ loaderData }) => headTags(loaderData?.head),
  component: ProductPage,
})

function ProductPage() {
  return <TemplateView page={Route.useLoaderData()} />
}
