import { createFileRoute } from '@tanstack/react-router'
import { MessageScreen } from '@/components/message-screen'
import { usePortal } from '@/components/portal-context'

export const Route = createFileRoute('/')({
  head: () => ({ meta: [{ name: 'robots', content: 'noindex' }] }),
  component: Landing,
})

function Landing() {
  const { t } = usePortal()
  return <MessageScreen title={t.landing.title} body={t.landing.body} />
}
