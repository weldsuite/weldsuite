import { createFileRoute } from '@tanstack/react-router'
import { TemplateView } from '@/components/template-view'
import { listingSearch } from '@/lib/search'
import { headTags } from '@/lib/seo'
import { getSearchPage } from '@/lib/server/loaders/catalogue'

export const Route = createFileRoute('/search')({
  validateSearch: listingSearch,
  loaderDeps: ({ search }) => ({ q: search.q, sort: search.sort, cursor: search.cursor }),
  loader: ({ deps }) => getSearchPage({ data: deps }),
  head: ({ loaderData }) => headTags(loaderData?.head),
  component: SearchPage,
})

function SearchPage() {
  return <TemplateView page={Route.useLoaderData()} />
}
