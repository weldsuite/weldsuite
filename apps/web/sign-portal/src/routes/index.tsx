import { createFileRoute, getRouteApi } from '@tanstack/react-router'
import { MessageScreen } from '@/components/message-screen'
import { dictionaries } from '@/lib/i18n'

const rootRoute = getRouteApi('__root__')

export const Route = createFileRoute('/')({
  component: HomePage,
})

function HomePage() {
  const t = dictionaries[rootRoute.useLoaderData().locale]
  return <MessageScreen title={t.home.title} body={t.home.body} footer={t.poweredBy} />
}
