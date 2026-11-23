import { useId } from 'react';
import { CartIcon, SearchIcon, UserIcon } from '../components/icons';
import { NarrowMenu, useMenu, WideMenu } from '../components/menu';
import { currentPage, ShopLink } from '../components/shop-link';
import { useShop } from '../context';
import { safeImageSrc } from '../links';
import { sectionSettings } from '../settings';
import { plural } from '../strings';
import type { SectionProps } from './types';

function Logo() {
  const { shop } = useShop();
  const src = safeImageSrc(shop.theme.logoUrl);
  return (
    <ShopLink href="/" className="flex shrink-0 items-center gap-2 font-heading text-xl font-semibold">
      {src ? (
        // Above the fold and small: loaded at once, never lazily.
        <img src={src} alt={shop.theme.logoAlt?.trim() || shop.name} decoding="async" className="h-10 w-auto max-w-48 object-contain" />
      ) : (
        shop.name
      )}
    </ShopLink>
  );
}

function SearchForm() {
  const { shop } = useShop();
  const id = useId();
  const s = shop.strings.nav;
  return (
    <search className="hidden lg:block">
      <form action="/search" method="get" className="flex items-center">
        <label htmlFor={id} className="sr-only">
          {s.searchLabel}
        </label>
        <input
          id={id}
          type="search"
          name="q"
          placeholder={s.searchPlaceholder}
          autoComplete="off"
          enterKeyHint="search"
          maxLength={100}
          className="shop-input h-10 w-56 rounded-e-none"
        />
        <button type="submit" className="shop-btn shop-btn-primary h-10 min-h-10 rounded-s-none px-3">
          <SearchIcon />
          <span className="sr-only">{s.search}</span>
        </button>
      </form>
    </search>
  );
}

/** The shop's header: logo, menu, search, account and cart. */
export function Header({ section, attributes }: Readonly<SectionProps>) {
  const { shop } = useShop();
  const settings = sectionSettings(section.type, section.settings);
  const items = useMenu(settings.text('menu') || 'main');
  const s = shop.strings.nav;
  const sticky = settings.bool('sticky');
  return (
    <header {...attributes} className={`border-b border-shop-border bg-shop-bg text-shop-fg ${sticky ? 'sticky top-0 z-30' : ''}`}>
      <div className="shop-container flex min-h-16 items-center gap-3 py-2 md:gap-6">
        <NarrowMenu items={items} />
        <Logo />
        <nav aria-label={s.main} className="min-w-0 flex-1">
          <WideMenu items={items} />
        </nav>
        <div className="ms-auto flex items-center gap-1">
          {settings.bool('showSearch') ? (
            <>
              <SearchForm />
              <ShopLink href="/search" className="shop-icon-btn lg:hidden" aria-current={currentPage(shop.path, '/search')}>
                <SearchIcon />
                <span className="sr-only">{s.search}</span>
              </ShopLink>
            </>
          ) : null}
          {settings.bool('showAccount') ? (
            <ShopLink href="/account" className="shop-icon-btn gap-2" aria-current={currentPage(shop.path, '/account')}>
              <UserIcon />
              <span className="sr-only sm:not-sr-only">{shop.signedIn ? s.account : s.signIn}</span>
            </ShopLink>
          ) : null}
          <ShopLink href="/cart" className="shop-icon-btn relative" aria-current={currentPage(shop.path, '/cart')}>
            <CartIcon />
            <span className="sr-only">{plural(shop.locale, s.cartCount, shop.cartCount)}</span>
            {shop.cartCount > 0 ? (
              <span aria-hidden="true" className="absolute -end-0.5 -top-0.5 min-w-5 rounded-full bg-shop-primary px-1 text-center text-xs font-semibold leading-5 text-shop-on-primary">
                {shop.cartCount > 99 ? '99+' : shop.cartCount}
              </span>
            ) : null}
          </ShopLink>
        </div>
      </div>
    </header>
  );
}
