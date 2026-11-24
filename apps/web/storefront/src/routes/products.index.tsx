import { createFileRoute } from '@tanstack/react-router'
import { TemplateView } from '@/components/template-view'
import { listingSearch } from '@/lib/search'
import { headTags } from '@/lib/seo'
import { getAllProductsPage } from '@/lib/server/loaders/catalogue'

export const Route = createFileRoute('/products/')({
  validateSearch: listingSearch,
  loaderDeps: ({ search }) => ({ sort: search.sort, cursor: search.cursor }),
  loader: ({ deps }) => getAllProductsPage({ data: deps }),
  head: ({ loaderData }) => headTags(loaderData?.head),
  component: AllProductsPage,
})

function AllProductsPage() {
  return <TemplateView page={Route.useLoaderData()} />
}
