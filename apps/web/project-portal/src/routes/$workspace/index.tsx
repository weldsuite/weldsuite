import { createFileRoute, redirect } from '@tanstack/react-router'
import { SignIn } from '@/components/sign-in'
import { getSessionState } from '@/lib/portal'
import { parseWorkspaceSlug } from '@/lib/slug'

type SignInReason = 'expired' | 'revoked'

/**
 * `/<workspace>`: sign in with an emailed code. Someone who already holds a
 * session goes straight to their projects. `?reason=` comes from a redirect
 * after a session ended; it shows why, and skips that shortcut (the cookie
 * was just cleared, and must not be trusted to send the reader in a loop).
 */
export const Route = createFileRoute('/$workspace/')({
  validateSearch: (search: Record<string, unknown>): { reason?: SignInReason } =>
    search.reason === 'expired' || search.reason === 'revoked' ? { reason: search.reason } : {},
  beforeLoad: async ({ params, search }) => {
    if (search.reason) return
    const { signedIn } = await getSessionState({ data: { workspace: params.workspace } })
    if (signedIn) throw redirect({ to: '/$workspace/projects', params: { workspace: params.workspace } })
  },
  component: SignInPage,
})

function SignInPage() {
  const { workspace } = Route.useParams()
  const { reason } = Route.useSearch()
  // The slug the session cookie is named by: the URL's, lowercased.
  return <SignIn workspace={parseWorkspaceSlug(workspace) ?? workspace} reason={reason} />
}
