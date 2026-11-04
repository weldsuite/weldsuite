import { useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { Button } from '@weldsuite/ui/components/button'
import { MessageScreen } from '@/components/message-screen'
import { usePortal } from '@/components/portal-context'

/**
 * What a page shows when its data could not be loaded. The cause stays in the
 * Worker's logs; the reader only needs to know it can be tried again.
 */
export function RouteError({ reset }: ErrorComponentProps) {
  const { t } = usePortal()
  const router = useRouter()
  return (
    <MessageScreen title={t.error.title} body={t.error.body}>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          reset()
          void router.invalidate()
        }}
      >
        {t.common.tryAgain}
      </Button>
    </MessageScreen>
  )
}
