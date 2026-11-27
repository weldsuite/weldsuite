import { createFileRoute, getRouteApi } from '@tanstack/react-router'
import { DocumentPage } from '@/components/document-page'
import { usePortalActions } from '@/lib/use-portal-actions'

const layout = getRouteApi('/d/$token')

export const Route = createFileRoute('/d/$token/')({
  component: DocumentView,
})

function DocumentView() {
  const { token } = Route.useParams()
  const { result, locale } = layout.useLoaderData()
  const actions = usePortalActions(token)
  if (!result.ok) return null
  return <DocumentPage document={result.data} locale={locale} pdfHref={`/d/${encodeURIComponent(token)}/pdf`} actions={actions} />
}
