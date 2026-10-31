import { createFileRoute, redirect } from '@tanstack/react-router'
import { getSignInPage } from '@/lib/portal'
import { safeNext } from '@/lib/portal-nav'
import { pageTitle } from '@/lib/site'
import { PortalError, PortalPage } from '@/components/portal/PortalShell'
import { SignInForm } from '@/components/portal/SignInForm'

export const Route = createFileRoute('/sign-in')({
  validateSearch: (search: Record<string, unknown>): { next?: string } =>
    typeof search.next === 'string' && search.next ? { next: search.next } : {},
  loaderDeps: ({ search }) => ({ next: search.next }),
  loader: async ({ deps }) => {
    const page = await getSignInPage()
    // Already signed in: straight on to where they were going.
    if (page.signedIn) throw redirect({ href: safeNext(deps.next), replace: true })
    return page
  },
  head: ({ matches }) => ({
    meta: [{ title: pageTitle(matches, 'Sign in') }, { name: 'robots', content: 'noindex' }],
  }),
  errorComponent: PortalError,
  component: SignInPage,
})

function SignInPage() {
  const { next } = Route.useSearch()
  return (
    <PortalPage narrow>
      <SignInForm next={next} />
    </PortalPage>
  )
}
