import { createFileRoute } from '@tanstack/react-router'
import { ApprovalsPage } from '@/components/account/approvals-page'
import { param } from '@/lib/search'
import { headTags } from '@/lib/seo'
import { getApprovalsPage } from '@/lib/server/loaders/account'

export const Route = createFileRoute('/account/approvals')({
  validateSearch: (search: Record<string, unknown>) => ({
    approved: param(search, 'approved', 60),
    rejected: param(search, 'rejected', 60),
    payment: param(search, 'payment', 10),
    error: param(search, 'error', 60),
  }),
  loader: () => getApprovalsPage(),
  head: ({ loaderData }) => headTags(loaderData?.head),
  component: Approvals,
})

function Approvals() {
  return <ApprovalsPage view={Route.useLoaderData()} notice={Route.useSearch()} />
}
