import { useEffect, useId, useRef, useState, type FocusEvent } from 'react';
import { useShop } from '../context';
import { format } from '../strings';
import type { MenuItem } from '../types';
import { currentPage, ShopLink } from './shop-link';

/** A menu item with its link resolved; items whose link points nowhere are left out. */
export interface ResolvedMenuItem {
  id: string;
  label: string;
  href: string;
  children: ResolvedMenuItem[];
}

export function useMenu(handle: string): ResolvedMenuItem[] {
  const { shop } = useShop();
  const resolve = (items: MenuItem[] | undefined, depth: number): ResolvedMenuItem[] =>
    (items ?? []).flatMap((item) => {
      const href = shop.resolveLink(item.link);
      if (!href) return [];
      return [{ id: item.id, label: item.label, href, children: depth < 1 ? resolve(item.children, depth + 1) : [] }];
    });
  return resolve(shop.menus[handle]?.items, 0);
}

/**
 * A top-level item of the wide navigation. With children, a button next to
 * the link opens them (Escape or moving focus away closes them).
 */
function WideItem({ item }: Readonly<{ item: ResolvedMenuItem }>) {
  const { shop } = useShop();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const link = (
    <ShopLink href={item.href} aria-current={currentPage(shop.path, item.href)} className="shop-nav-link">
      {item.label}
    </ShopLink>
  );
  const itemRef = useRef<HTMLLIElement>(null);
  // Escape anywhere in the open submenu closes it and returns focus to its button.
  useEffect(() => {
    const element = itemRef.current;
    if (!element || !open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    element.addEventListener('keydown', onKeyDown);
    return () => element.removeEventListener('keydown', onKeyDown);
  }, [open]);
  if (item.children.length === 0) return <li>{link}</li>;
  const onBlur = (event: FocusEvent<HTMLLIElement>) => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
  };
  return (
    <li ref={itemRef} className="relative flex items-center" onBlur={onBlur}>
      {link}
      <button
        ref={button}
        type="button"
        className="shop-icon-btn"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={format(shop.strings.nav.submenu, { label: item.label })}
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      <ul id={listId} hidden={!open} className="absolute start-0 top-full z-40 mt-2 min-w-56 rounded-shop border border-shop-border bg-shop-bg p-2 shadow-lg">
        {item.children.map((child) => (
          <li key={child.id}>
            <ShopLink href={child.href} aria-current={currentPage(shop.path, child.href)} className="block rounded-shop px-3 py-2 hover:bg-shop-muted">
              {child.label}
            </ShopLink>
          </li>
        ))}
      </ul>
    </li>
  );
}

/** The menu inline, for wide screens. */
export function WideMenu({ items }: Readonly<{ items: ResolvedMenuItem[] }>) {
  return (
    <ul className="hidden flex-wrap items-center gap-x-1 md:flex">
      {items.map((item) => (
        <WideItem key={item.id} item={item} />
      ))}
    </ul>
  );
}

/**
 * The menu behind a "Menu" button, for narrow screens: a native popover
 * (light dismiss and Escape for free). Browsers without popovers show the
 * list in place and hide the button (styles.css).
 */
export function NarrowMenu({ items }: Readonly<{ items: ResolvedMenuItem[] }>) {
  const { shop } = useShop();
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null);
  // A link in the menu navigates without a reload: close the menu on the new page.
  useEffect(() => {
    const element = menu.current;
    try {
      if (element?.matches(':popover-open')) element.hidePopover();
    } catch {
      // No popover support: the list is shown in place (styles.css).
    }
  }, [shop.path]);
  if (items.length === 0) return null;
  return (
    <div className="md:hidden">
      <button type="button" popoverTarget={menuId} className="shop-menu-button shop-icon-btn gap-2">
        <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5">
          <path d="M4 6h16M4 12h16M4 18h16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        </svg>
        <span>{shop.strings.nav.menu}</span>
      </button>
      <div ref={menu} id={menuId} popover="auto" className="shop-mobile-menu">
        <ul className="flex flex-col">
          {items.map((item) => (
            <li key={item.id}>
              <ShopLink href={item.href} aria-current={currentPage(shop.path, item.href)} className="block rounded-shop px-3 py-3 font-medium hover:bg-shop-muted">
                {item.label}
              </ShopLink>
              {item.children.length > 0 ? (
                <ul className="ms-4 border-s border-shop-border ps-2">
                  {item.children.map((child) => (
                    <li key={child.id}>
                      <ShopLink href={child.href} aria-current={currentPage(shop.path, child.href)} className="block rounded-shop px-3 py-2 hover:bg-shop-muted">
                        {child.label}
                      </ShopLink>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
