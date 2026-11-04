import { createFileRoute } from '@tanstack/react-router'
import { MessageScreen } from '@/components/message-screen'
import { usePortal } from '@/components/portal-context'

export const Route = createFileRoute('/')({
  component: HomePage,
})

/** The bare address: the portal is opened from a workspace's own link, `/<workspace>`. */
function HomePage() {
  const { t } = usePortal()
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col justify-center px-4 sm:px-6">
      <MessageScreen title={t.home.title} body={t.home.body} />
    </div>
  )
}
