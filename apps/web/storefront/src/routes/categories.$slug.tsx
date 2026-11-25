import { createFileRoute } from '@tanstack/react-router'
import { TemplateView } from '@/components/template-view'
import { segment } from '@/lib/paths'
import { listingSearch } from '@/lib/search'
import { headTags } from '@/lib/seo'
import { getCategoryPage } from '@/lib/server/loaders/catalogue'

export const Route = createFileRoute('/categories/$slug')({
  validateSearch: listingSearch,
  loaderDeps: ({ search }) => ({ sort: search.sort, cursor: search.cursor }),
  loader: ({ params, deps }) => getCategoryPage({ data: { slug: segment(params.slug), ...deps } }),
  head: ({ loaderData }) => headTags(loaderData?.head),
  component: CategoryPage,
})

function CategoryPage() {
  return <TemplateView page={Route.useLoaderData()} />
}
