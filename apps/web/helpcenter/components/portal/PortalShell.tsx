import { Suspense, type ReactNode } from 'react'
import { useRouter } from '@tanstack/react-router'
import { usePortalStrings } from '@/lib/portal-i18n'
import { secondaryButtonClass } from '@/components/portal/styles'

/** Page frame for the portal; holds the Suspense boundary the translations need. */
export function PortalPage({ children, narrow }: Readonly<{ children: ReactNode; narrow?: boolean }>) {
  return (
    <div className={narrow ? 'mx-auto w-full max-w-md py-10 lg:py-16' : 'max-w-3xl py-10 lg:py-14'}>
      <Suspense fallback={<div className="h-64" aria-hidden="true" />}>{children}</Suspense>
    </div>
  )
}

function PortalErrorInner() {
  const t = usePortalStrings()
  const router = useRouter()
  return (
    <div className="py-16 text-center">
      <p className="text-zinc-600 dark:text-zinc-300">{t.errors.loadFailed}</p>
      <button type="button" onClick={() => void router.invalidate()} className={`${secondaryButtonClass} mt-6`}>
        {t.errors.retry}
      </button>
    </div>
  )
}

/** errorComponent for the portal routes (widget-api down, unexpected answer). */
export function PortalError() {
  return (
    <PortalPage>
      <PortalErrorInner />
    </PortalPage>
  )
}
