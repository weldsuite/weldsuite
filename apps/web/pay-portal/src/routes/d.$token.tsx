import { Outlet, createFileRoute, useRouter } from '@tanstack/react-router'
import { MessageScreen } from '@/components/message-screen'
import { dictionaries } from '@/lib/i18n'
import { loadDocument } from '@/lib/server-fns'

/**
 * One link, one document. The loader reads it from the backend on every visit
 * (opening the page is what the backend counts as "viewed"), for the document
 * page and the return page alike. A link that does not work shows one calm
 * sentence and answers 404.
 */
export const Route = createFileRoute('/d/$token')({
  loader: ({ params }) => loadDocument({ data: { token: params.token } }),
  staleTime: 0,
  gcTime: 0,
  head: ({ loaderData }) => {
    if (!loaderData) return {}
    const t = dictionaries[loaderData.locale]
    const { result } = loaderData
    return { meta: [{ title: result.ok ? `${t.kind[result.data.kind]} ${result.data.number} · ${result.data.seller.name}` : t.invalid.title }] }
  },
  component: DocumentLayout,
})

function DocumentLayout() {
  const { result, locale } = Route.useLoaderData()
  const router = useRouter()
  const t = dictionaries[locale]
  if (result.ok) return <Outlet />
  if (result.reason === 'not_found') return <MessageScreen title={t.invalid.title} body={t.invalid.body} />
  return (
    <MessageScreen title={t.error.title} body={t.error.body}>
      <button type="button" className="mx-auto underline" onClick={() => void router.invalidate()}>
        {t.error.retry}
      </button>
    </MessageScreen>
  )
}
