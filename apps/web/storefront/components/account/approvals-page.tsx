import { errorMessage, format, OrderLines, useShop } from '@weldsuite/storefront-theme'
import { useId } from 'react'
import { decideApproval } from '@/lib/server/actions/account'
import type { ApprovalsView } from '@/lib/server/loaders/account'
import { FormMessage, ShopForm, SubmitButton } from '../shop-form'
import { QueryError } from '../template-view'

function Decision({ orderId }: Readonly<{ orderId: string }>) {
  const { shop } = useShop()
  const s = shop.strings.b2b
  const commentId = useId()
  return (
    <ShopForm action={decideApproval} className="flex flex-col gap-3">
      <input type="hidden" name="orderId" value={orderId} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={commentId} className="shop-label">
          {s.comment} <span className="shop-hint font-normal">({shop.strings.common.optional})</span>
        </label>
        <textarea id={commentId} name="comment" maxLength={2000} rows={2} className="shop-input" />
      </div>
      <FormMessage />
      <div className="flex flex-wrap gap-3">
        <SubmitButton name="decision" value="approve">
          {s.approve}
        </SubmitButton>
        <SubmitButton name="decision" value="reject" className="shop-btn shop-btn-secondary">
          {s.reject}
        </SubmitButton>
      </div>
    </ShopForm>
  )
}

/** B2B: orders of the active company that wait for the shopper's approval. */
export function ApprovalsPage({ view, notice }: Readonly<{ view: ApprovalsView; notice: { approved?: string; rejected?: string; payment?: string } }>) {
  const { shop } = useShop()
  const s = shop.strings.b2b
  let done: string | null = null
  if (notice.approved) done = format(s.approved, { number: notice.approved })
  else if (notice.rejected) done = format(s.rejected, { number: notice.rejected })
  return (
    <div className="shop-container shop-section flex flex-col gap-8">
      <QueryError />
      <h1 className="text-3xl font-semibold md:text-4xl">{s.approvalsTitle}</h1>
      {done ? (
        <p role="status" className="shop-notice">
          {done} {notice.payment === 'sent' ? s.paymentSent : ''}
        </p>
      ) : null}
      {view.refused ? <p className="shop-alert">{errorMessage(shop.strings, view.refused)}</p> : null}
      {!view.refused && view.approvals.length === 0 ? <p>{s.approvalsEmpty}</p> : null}
      {view.approvals.map((approval) => (
        <section key={approval.order.id} aria-labelledby={`approval-${approval.order.id}`} className="flex flex-col gap-4 rounded-shop border border-shop-border p-5">
          <h2 id={`approval-${approval.order.id}`} className="text-xl font-semibold">
            {format(shop.strings.order.title, { number: approval.order.orderNumber })}
          </h2>
          <p className="shop-hint">
            {s.reasons[approval.reason as keyof typeof s.reasons] ?? approval.reason}
            {approval.requestedBy?.name ? ` · ${format(s.requestedBy, { name: approval.requestedBy.name })}` : ''}
          </p>
          <OrderLines order={approval.order} />
          <Decision orderId={approval.order.id} />
        </section>
      ))}
    </div>
  )
}
