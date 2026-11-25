/**
 * The renderer's pieces the theme's sections draw (`ShopSlots`): links that
 * navigate without a reload, and the forms that post to server functions.
 */

import { useRouter } from '@tanstack/react-router'
import type { Cart, CartLine, StorefrontProduct } from '@weldsuite/commerce-sdk'
import { format, ProductBuyFields, ShopLink, useShop, type ShopLinkProps, type ShopSlots } from '@weldsuite/storefront-theme'
import type { MouseEvent } from 'react'
import { addItem, discountCode, removeLine, updateLine } from '@/lib/server/actions/cart'
import { Field, FormMessage, ShopForm, SubmitButton } from './shop-form'

/** A path of the shop, navigated by the router (a modified click or a middle click still opens a tab). */
function RouterLink({ href, onClick, children, ...props }: Readonly<ShopLinkProps>) {
  const router = useRouter()
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (props.target && props.target !== '_self') return
    event.preventDefault()
    void router.navigate({ href })
  }
  return (
    <a href={href} onClick={handle} {...props}>
      {children}
    </a>
  )
}

function AddToCart({ product, showSku }: Readonly<{ product: StorefrontProduct; showSku: boolean }>) {
  const { shop } = useShop()
  return (
    <ShopForm action={addItem} back={`/products/${encodeURIComponent(product.slug)}`} aria-label={product.name} className="flex flex-col gap-4">
      {({ pending, result }) => (
        <>
          <ProductBuyFields product={product} pending={pending} showSku={showSku} />
          <FormMessage />
          {result?.ok ? (
            <p>
              <ShopLink href="/cart" className="font-medium underline underline-offset-4">
                {shop.strings.product.viewCart}
              </ShopLink>
            </p>
          ) : null}
        </>
      )}
    </ShopForm>
  )
}

function CartLineControls({ line }: Readonly<{ cart: Cart; line: CartLine }>) {
  const { shop } = useShop()
  const s = shop.strings.cart
  const name = line.variantName ? `${line.name} (${line.variantName})` : line.name
  return (
    <div className="flex flex-wrap items-center gap-3">
      <ShopForm action={updateLine} className="flex items-center gap-1" aria-label={`${s.quantity}: ${name}`}>
        <input type="hidden" name="lineId" value={line.id} />
        <SubmitButton name="set" value={String(Math.max(0, line.quantity - 1))} className="shop-icon-btn border border-shop-border">
          <span aria-hidden="true">−</span>
          <span className="sr-only">{format(s.decrease, { name })}</span>
        </SubmitButton>
        <span className="min-w-8 text-center tabular-nums" aria-live="polite">
          <span className="sr-only">{`${s.quantity}: `}</span>
          {line.quantity}
        </span>
        <SubmitButton name="set" value={String(Math.min(999, line.quantity + 1))} className="shop-icon-btn border border-shop-border">
          <span aria-hidden="true">+</span>
          <span className="sr-only">{format(s.increase, { name })}</span>
        </SubmitButton>
        <FormMessage success={false} />
      </ShopForm>
      <ShopForm action={removeLine}>
        <input type="hidden" name="lineId" value={line.id} />
        <SubmitButton className="text-sm underline underline-offset-4">
          <span aria-hidden="true">{s.remove}</span>
          <span className="sr-only">{format(s.removeItem, { name })}</span>
        </SubmitButton>
      </ShopForm>
    </div>
  )
}

function DiscountForm({ cart }: Readonly<{ cart: Cart }>) {
  const { shop } = useShop()
  const s = shop.strings.cart
  if (cart.discount) {
    return (
      <ShopForm action={discountCode} back="/cart">
        <input type="hidden" name="remove" value="1" />
        <SubmitButton className="text-sm underline underline-offset-4">{format(s.removeDiscount, { code: cart.discount.code })}</SubmitButton>
      </ShopForm>
    )
  }
  return (
    <ShopForm action={discountCode} back="/cart" resetOnSuccess className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <Field
          name="code"
          label={s.discountCode}
          className="flex-1"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={100}
          enterKeyHint="go"
        />
        <SubmitButton className="shop-btn shop-btn-secondary">{s.applyDiscount}</SubmitButton>
      </div>
      <FormMessage />
    </ShopForm>
  )
}

export const SHOP_SLOTS: ShopSlots = {
  Link: RouterLink,
  AddToCart,
  CartLineControls,
  DiscountForm,
}
