/**
 * What a section may know besides its own settings: the shop (language,
 * channel, theme, menus, who is signed in), the data the renderer loaded for
 * the page, and the renderer's own pieces for anything interactive (links
 * that navigate without a reload, the forms that post to its server
 * functions). Sections never fetch and never post: they draw what is here.
 */

import type {
  Cart,
  CartLine,
  ChannelAudience,
  PaymentMethod,
  ProductSort,
  StorefrontCategory,
  StorefrontProduct,
} from '@weldsuite/commerce-sdk';
import { createContext, useContext, type AnchorHTMLAttributes, type ComponentType, type ReactNode } from 'react';
import type { ShopStrings } from './strings';
import type { ListName, Menu, MenuLink, PublishedPage, SectionList, ShopAccess, ShopLocale, ThemeSettings } from './types';

/** The channel as the site document carries it. */
export interface ShopChannel {
  id: string;
  name: string;
  audience: ChannelAudience;
  currency: string;
  pricesIncludeTax: boolean;
  guestCheckout: boolean;
  paymentMethods: PaymentMethod[];
}

export interface ShopInfo {
  /** The shop's name (the channel's), for the logo text and titles. */
  name: string;
  locale: ShopLocale;
  /** BCP 47, for prices and dates (`intlLocale(locale)`). */
  intlLocale: string;
  strings: ShopStrings;
  channel: ShopChannel;
  theme: ThemeSettings;
  menus: Record<string, Menu>;
  access: ShopAccess;
  signedIn: boolean;
  /** `false` when the shop shows prices to signed-in buyers only and nobody is signed in. */
  showPrices: boolean;
  cartCount: number;
  /** The current path, for `aria-current`. */
  path: string;
  preview: boolean;
  /** WeldForms' portal origin, for contact forms; null when the install has none. */
  formsPortalUrl: string | null;
  /** A menu link as a path or URL of this shop; null when it points nowhere (a hidden page). */
  resolveLink: (link: MenuLink) => string | null;
  /** Paths of the legal pages, when the shop has them. */
  legalPaths: { terms: string | null; privacy: string | null; withdrawal: string | null };
}

/** A grid of products: all of them, a category's, or search results. */
export interface ProductListing {
  kind: 'all' | 'category' | 'search';
  category: StorefrontCategory | null;
  /** The search words (`search` only). */
  query: string;
  products: StorefrontProduct[];
  sort: ProductSort;
  /** The page's own path, without query (the sort form posts here). */
  path: string;
  /** The next page; null on the last one. */
  nextHref: string | null;
  /** The first page, when this is a later one. */
  firstHref: string | null;
}

/** What one section asked the renderer to load (see `sectionDataRequests`). */
export interface SectionData {
  products?: StorefrontProduct[];
}

export interface ShopData {
  /** The product of a product page; null when it was not found. */
  product?: StorefrontProduct | null;
  listing?: ProductListing | null;
  cart?: Cart | null;
  /** The content page of `/pages/$slug`. */
  page?: PublishedPage | null;
  /** The category tree, when a section needs it. */
  categories?: StorefrontCategory[];
  /** By `sectionDataKey(list, sectionId)`. */
  sections?: Record<string, SectionData>;
}

export interface ShopLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  href: string;
  children?: ReactNode;
}

/** The renderer's pieces for what a pure section cannot do itself. */
export interface ShopSlots {
  /** A link to a path of the shop that navigates without a full reload. Defaults to `<a>`. */
  Link?: ComponentType<ShopLinkProps>;
  /** The product page's buy form (variant picker, quantity, add to cart): posts to the renderer. */
  AddToCart?: ComponentType<{ product: StorefrontProduct; showSku: boolean }>;
  /** A cart line's quantity and remove controls. */
  CartLineControls?: ComponentType<{ cart: Cart; line: CartLine }>;
  /** The cart's discount code form. */
  DiscountForm?: ComponentType<{ cart: Cart }>;
}

export interface ShopContextValue {
  shop: ShopInfo;
  data: ShopData;
  slots: ShopSlots;
}

const ShopContext = createContext<ShopContextValue | null>(null);

export function ShopProvider({ shop, data, slots, children }: Readonly<ShopContextValue & { children: ReactNode }>) {
  return <ShopContext.Provider value={{ shop, data, slots }}>{children}</ShopContext.Provider>;
}

export function useShop(): ShopContextValue {
  const value = useContext(ShopContext);
  if (!value) throw new Error('A storefront section was drawn outside <ShopProvider>.');
  return value;
}

/** The shop context, or null outside a `ShopProvider` (error pages that may draw before the shop loaded). */
export function useOptionalShop(): ShopContextValue | null {
  return useContext(ShopContext);
}

/** The key of a section's data: section ids are unique within a list only. */
export function sectionDataKey(list: ListName, sectionId: string): string {
  return `${list}:${sectionId}`;
}

/** Draws a list of sections (`SectionRenderer` provides it, so `main-page` can draw a page's own). */
export type RenderList = (sections: SectionList, list: ListName, options?: { firstHeadingLevel?: 1 | 2; priorityFirst?: boolean }) => ReactNode;

export const RenderListContext = createContext<RenderList | null>(null);
