import { createFileRoute } from '@tanstack/react-router'
import { ShopLink, useShop } from '@weldsuite/storefront-theme'
import { OrderView } from '@/components/account/order-view'
import { FormMessage, ShopForm, SubmitButton } from '@/components/shop-form'
import { QueryError } from '@/components/template-view'
import { segment } from '@/lib/paths'
import { param } from '@/lib/search'
import { headTags } from '@/lib/seo'
import { reorder } from '@/lib/server/actions/account'
import { getOrderPage } from '@/lib/server/loaders/account'

export const Route = createFileRoute('/account/orders/$id')({
  validateSearch: (search: Record<string, unknown>) => ({ error: param(search, 'error', 60) }),
  loader: ({ params }) => getOrderPage({ data: { id: segment(params.id) } }),
  head: ({ loaderData }) => headTags(loaderData?.head),
  component: Order,
})

function Order() {
  const { order } = Route.useLoaderData()
  const { shop } = useShop()
  const s = shop.strings.order
  return (
    <div className="shop-container shop-section flex flex-col gap-6">
      <QueryError />
      <ShopLink href="/account/orders" className="text-sm underline underline-offset-4">
        {s.backToOrders}
      </ShopLink>
      <OrderView
        order={order}
        actions={
          <ShopForm action={reorder} className="flex flex-col items-end gap-3">
            <input type="hidden" name="orderId" value={order.id} />
            <SubmitButton pendingText={s.reordering}>{s.reorder}</SubmitButton>
            <FormMessage />
          </ShopForm>
        }
      />
    </div>
  )
}
