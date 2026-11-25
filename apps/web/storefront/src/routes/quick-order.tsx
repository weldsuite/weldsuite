import { createFileRoute } from '@tanstack/react-router'
import { QuickOrderPage } from '@/components/account/quick-order-page'
import { param } from '@/lib/search'
import { headTags } from '@/lib/seo'
import { getQuickOrderPage } from '@/lib/server/loaders/account'

export const Route = createFileRoute('/quick-order')({
  validateSearch: (search: Record<string, unknown>) => ({ error: param(search, 'error', 60) }),
  loader: () => getQuickOrderPage(),
  head: ({ loaderData }) => headTags(loaderData?.head),
  component: QuickOrderPage,
})
