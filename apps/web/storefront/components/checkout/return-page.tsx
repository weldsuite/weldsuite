import { errorMessage, format, OrderLines, ShopLink, useShop, type ShopStrings } from '@weldsuite/storefront-theme'
import { retryPayment } from '@/lib/server/actions/checkout'
import type { ReturnView } from '@/lib/server/loaders/checkout'
import { withQuery } from '@/lib/paths'
import { ShopForm, SubmitButton } from '../shop-form'

type ReturnStrings = ShopStrings['orderReturn']

/** The confirmation of a placed order: waiting for approval or not, paid by Mollie or on invoice. */
function placedTemplate(s: ReturnStrings, view: ReturnView): string {
  if (view.order?.approvalStatus === 'pending') return view.method === 'mollie' ? s.placedApprovalMollie : s.placedApproval
  return view.method === 'invoice' ? s.placedInvoice : s.placed
}

/** Why the payment did not go through, from its status. */
function failedTemplate(s: ReturnStrings, status: string | undefined): string {
  if (status === 'canceled') return s.canceled
  if (status === 'expired') return s.expired
  return s.failed
}

function useOutcomeText(view: ReturnView): { title: string; text: string } {
  const { shop } = useShop()
  const s = shop.strings.orderReturn
  const number = view.number
  switch (view.outcome) {
    case 'placed':
      return { title: s.placedTitle, text: format(placedTemplate(s, view), { number }) }
    case 'paid':
      return { title: s.paidTitle, text: format(s.paid, { number }) }
    case 'waiting':
      return { title: s.waitingTitle, text: format(s.waiting, { number }) }
    case 'failed':
      return { title: s.failedTitle, text: format(failedTemplate(s, view.payment?.status), { number }) }
    default:
      return { title: s.unknownTitle, text: format(s.unknown, { number }) }
  }
}

/**
 * Where Mollie sends the shopper back, and the confirmation of an order on
 * invoice. The payment's status is read back through the API, never taken
 * from the URL.
 */
export function ReturnPage({ view }: Readonly<{ view: ReturnView }>) {
  const { shop } = useShop()
  const s = shop.strings.orderReturn
  const { title, text } = useOutcomeText(view)
  if (!view.found) {
    return (
      <div className="shop-container shop-section flex max-w-2xl flex-col items-start gap-4">
        <h1 className="text-3xl font-semibold">{s.notFoundTitle}</h1>
        <p>{s.notFound}</p>
        <ShopLink href="/account/orders" className="shop-btn shop-btn-secondary">
          {s.yourOrders}
        </ShopLink>
      </div>
    )
  }
  const again = withQuery('/checkout/return', { order: view.orderId, payment: view.paymentId })
  return (
    <div className="shop-container shop-section flex flex-col gap-8">
      <div className="flex max-w-2xl flex-col items-start gap-4">
        <h1 className="text-3xl font-semibold md:text-4xl">{title}</h1>
        <p role="status">{text}</p>
        {view.error ? (
          <p role="alert" className="shop-alert">
            {errorMessage(shop.strings, view.error)}
          </p>
        ) : null}
        {view.outcome === 'waiting' || view.outcome === 'unknown' ? (
          <ShopLink href={again} className="shop-btn shop-btn-secondary">
            {s.checkAgain}
          </ShopLink>
        ) : null}
        {view.outcome === 'failed' && view.paymentId ? (
          <ShopForm action={retryPayment}>
            <input type="hidden" name="orderId" value={view.orderId} />
            <input type="hidden" name="paymentId" value={view.paymentId} />
            <SubmitButton pendingText={s.starting}>{s.tryAgain}</SubmitButton>
          </ShopForm>
        ) : null}
        {view.link ? (
          <ShopLink href={view.link} className="font-medium underline underline-offset-4">
            {s.viewOrder}
          </ShopLink>
        ) : null}
      </div>
      {view.order ? (
        <section aria-labelledby="order-heading" className="flex flex-col gap-4">
          <h2 id="order-heading" className="text-xl font-semibold">
            {format(shop.strings.order.title, { number: view.order.orderNumber })}
          </h2>
          <OrderLines order={view.order} />
        </section>
      ) : null}
    </div>
  )
}
