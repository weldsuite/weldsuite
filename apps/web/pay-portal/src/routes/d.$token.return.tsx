import { createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router'
import { ReturnView } from '@/components/return-view'
import { usePortalActions } from '@/lib/use-portal-actions'

const layout = getRouteApi('/d/$token')

/** Where Mollie sends the customer back: the layout's loader has just read the document again. */
export const Route = createFileRoute('/d/$token/return')({
  component: PaymentReturn,
})

function PaymentReturn() {
  const { token } = Route.useParams()
  const { result, locale } = layout.useLoaderData()
  const router = useRouter()
  const actions = usePortalActions(token)
  if (!result.ok) return null
  return (
    <ReturnView
      document={result.data}
      locale={locale}
      backHref={`/d/${encodeURIComponent(token)}`}
      onRefresh={() => void router.invalidate()}
      actions={actions}
    />
  )
}
