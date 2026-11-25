import { createFileRoute } from '@tanstack/react-router'
import { AccountPage } from '@/components/account/account-page'
import { SignIn } from '@/components/account/sign-in'
import { param } from '@/lib/search'
import { headTags } from '@/lib/seo'
import { getAccountPage } from '@/lib/server/loaders/account'

export const Route = createFileRoute('/account/')({
  validateSearch: (search: Record<string, unknown>) => ({ next: param(search, 'next', 500), error: param(search, 'error', 60) }),
  loaderDeps: ({ search }) => ({ next: search.next }),
  loader: ({ deps }) => getAccountPage({ data: deps }),
  head: ({ loaderData }) => headTags(loaderData?.head),
  component: Account,
})

function Account() {
  const view = Route.useLoaderData()
  if (!view.signedIn) return <SignIn step={view.step} email={view.email} next={view.next} reason={view.reason} />
  return <AccountPage shopper={view.shopper} orders={view.orders} b2b={view.b2b} />
}
