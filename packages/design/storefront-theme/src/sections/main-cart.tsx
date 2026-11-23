import type { Cart, CartLine } from '@weldsuite/commerce-sdk';
import { AlertIcon } from '../components/icons';
import { useMoney } from '../components/price';
import { ShopLink } from '../components/shop-link';
import { ThemeImage } from '../components/theme-image';
import { Totals } from '../components/totals';
import { useShop } from '../context';
import { RichText } from '../markdown';
import { sectionSettings } from '../settings';
import { discountReason, format } from '../strings';
import type { SectionProps } from './types';

function Line({ cart, line }: Readonly<{ cart: Cart; line: CartLine }>) {
  const { shop, slots } = useShop();
  const money = useMoney();
  const s = shop.strings.cart;
  const Controls = slots.CartLineControls;
  return (
    <li className="grid grid-cols-[5rem_1fr] gap-4 border-b border-shop-border py-5 sm:grid-cols-[6rem_1fr_auto]">
      <div className="aspect-square overflow-hidden rounded-shop bg-shop-muted">
        {line.imageUrl ? <ThemeImage src={line.imageUrl} alt="" className="size-full object-cover" /> : null}
      </div>
      <div className="flex flex-col gap-1">
        <h2 className="font-medium">
          <ShopLink href={`/products/${encodeURIComponent(line.productId)}`} className="underline-offset-4 hover:underline">
            {line.name}
          </ShopLink>
        </h2>
        {line.variantName ? <p className="shop-hint">{line.variantName}</p> : null}
        <p className="tabular-nums">{money(line.unitPrice, cart.currency)}</p>
        {line.problem ? (
          <p className="shop-alert-inline">
            <AlertIcon className="size-4 shrink-0" />
            {s.lineProblems[line.problem]}
          </p>
        ) : null}
        <div className="mt-2">{Controls ? <Controls cart={cart} line={line} /> : <span>{`${s.quantity}: ${line.quantity}`}</span>}</div>
      </div>
      <p className="col-start-2 font-semibold tabular-nums sm:col-start-3 sm:text-end">{money(line.total, cart.currency)}</p>
    </li>
  );
}

function Summary({ cart, showDiscount, note }: Readonly<{ cart: Cart; showDiscount: boolean; note: string }>) {
  const { shop, slots } = useShop();
  const s = shop.strings.cart;
  const DiscountForm = slots.DiscountForm;
  const hasProblems = cart.items.some((line) => line.problem);
  return (
    <aside aria-labelledby="cart-summary" className="flex flex-col gap-5 self-start rounded-shop bg-shop-muted p-6 text-shop-on-muted">
      <h2 id="cart-summary" className="text-xl font-semibold">
        {s.summary}
      </h2>
      <Totals totals={cart} shippingKnown={Boolean(cart.shippingRate)} taxKnown={Boolean(cart.shippingAddress)} />
      {showDiscount ? (
        cart.discount ? (
          <div className="flex flex-col gap-1">
            <p>{format(s.discountApplied, { code: cart.discount.code })}</p>
            {DiscountForm ? <DiscountForm cart={cart} /> : null}
          </div>
        ) : DiscountForm ? (
          <DiscountForm cart={cart} />
        ) : null
      ) : null}
      {cart.discountProblem ? <p className="shop-alert-inline">{discountReason(shop.strings, cart.discountProblem)}</p> : null}
      <RichText source={note} baseLevel={3} />
      {hasProblems ? <p className="shop-alert-inline">{s.fixProblems}</p> : null}
      <ShopLink href="/checkout" className="shop-btn shop-btn-primary w-full text-lg">
        {s.checkout}
      </ShopLink>
    </aside>
  );
}

/** The cart page: the lines with their controls, then the totals and the way to checkout. */
export function MainCart({ section, attributes }: Readonly<SectionProps>) {
  const { shop, data } = useShop();
  const settings = sectionSettings(section.type, section.settings);
  const s = shop.strings.cart;
  const cart = data.cart;
  const empty = !cart || cart.items.length === 0;
  return (
    <section {...attributes} aria-labelledby="cart-title" className="shop-container shop-section flex flex-col gap-8">
      <h1 id="cart-title" className="text-3xl font-semibold md:text-4xl">
        {s.title}
      </h1>
      {empty ? (
        <div className="flex flex-col items-start gap-4">
          <p>{s.empty}</p>
          <ShopLink href="/products" className="shop-btn shop-btn-primary">
            {shop.strings.common.continueShopping}
          </ShopLink>
        </div>
      ) : (
        <div className="grid gap-10 lg:grid-cols-[1fr_24rem]">
          {/* eslint-disable-next-line jsx-a11y/no-redundant-roles -- Safari drops list semantics from unstyled lists */}
          <ul role="list" aria-labelledby="cart-title" className="border-t border-shop-border">
            {cart.items.map((line) => (
              <Line key={line.id} cart={cart} line={line} />
            ))}
          </ul>
          <Summary cart={cart} showDiscount={settings.bool('showDiscount')} note={settings.text('note')} />
        </div>
      )}
    </section>
  );
}
