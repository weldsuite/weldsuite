import { createFileRoute } from '@tanstack/react-router'
import { TemplateView } from '@/components/template-view'
import { headTags } from '@/lib/seo'
import { getHomePage } from '@/lib/server/loaders/catalogue'

export const Route = createFileRoute('/')({
  loader: () => getHomePage(),
  head: ({ loaderData }) => headTags(loaderData?.head),
  component: HomePage,
})

function HomePage() {
  return <TemplateView page={Route.useLoaderData()} />
}
