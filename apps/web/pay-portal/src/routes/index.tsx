import { createFileRoute, getRouteApi } from '@tanstack/react-router'
import { MessageScreen } from '@/components/message-screen'
import { dictionaries } from '@/lib/i18n'

const root = getRouteApi('__root__')

/** A plain explanation. It never lists anything: a document is only reachable by its link. */
export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  const t = dictionaries[root.useLoaderData()]
  return <MessageScreen title={t.home.title} body={t.home.body} />
}
