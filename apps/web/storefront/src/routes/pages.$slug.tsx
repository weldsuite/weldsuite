import { createFileRoute } from '@tanstack/react-router'
import { TemplateView } from '@/components/template-view'
import { segment } from '@/lib/paths'
import { headTags } from '@/lib/seo'
import { getContentPage } from '@/lib/server/loaders/catalogue'

export const Route = createFileRoute('/pages/$slug')({
  loader: ({ params }) => getContentPage({ data: { slug: segment(params.slug) } }),
  head: ({ loaderData }) => headTags(loaderData?.head),
  component: ContentPage,
})

function ContentPage() {
  return <TemplateView page={Route.useLoaderData()} />
}
