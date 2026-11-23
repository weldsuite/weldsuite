import { useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { useOptionalShop, useShop } from '@weldsuite/storefront-theme'

/** A page that failed to load: say so in the shop's language, and offer to try again. */
export function RouteError({ reset }: Readonly<ErrorComponentProps>) {
  const router = useRouter()
  const inShop = useOptionalShop() !== null
  return inShop ? <ShopError onRetry={() => { reset(); void router.invalidate() }} /> : <PlainError />
}

function ShopError({ onRetry }: Readonly<{ onRetry: () => void }>) {
  const { shop } = useShop()
  return (
    <section className="shop-container shop-section flex max-w-2xl flex-col items-start gap-4">
      <h1 className="text-3xl font-semibold">{shop.strings.errors.local.SHOP_UNAVAILABLE}</h1>
      <button type="button" className="shop-btn shop-btn-primary" onClick={onRetry}>
        {shop.strings.orderReturn.checkAgain}
      </button>
    </section>
  )
}

function PlainError() {
  return (
    <main className="p-8">
      <h1 className="text-2xl font-semibold">The shop is not available right now</h1>
      <p>Try again in a moment.</p>
    </main>
  )
}
