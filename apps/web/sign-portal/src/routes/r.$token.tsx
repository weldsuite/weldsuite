import { createFileRoute, getRouteApi } from '@tanstack/react-router'
import { SigningFlow } from '@/components/signing-flow'

const rootRoute = getRouteApi('__root__')

/**
 * A signer's personal link, `/r/<token>`. The route stays thin: it passes the
 * first-paint language and the disclosure version (both from the root's server
 * loader); everything else is the client flow in `components/signing-flow.tsx`.
 */
export const Route = createFileRoute('/r/$token')({
  component: SigningLinkPage,
})

function SigningLinkPage() {
  const { token } = Route.useParams()
  const { locale, disclosureVersion } = rootRoute.useLoaderData()
  return <SigningFlow token={token} initialLocale={locale} disclosureVersion={disclosureVersion} />
}
