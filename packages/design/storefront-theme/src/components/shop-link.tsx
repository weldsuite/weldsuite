import { useShop, type ShopLinkProps } from '../context';
import { safeLink } from '../links';

/**
 * A link a merchant set (a button, a menu item): a path of this shop goes
 * through the renderer's `Link` (no full reload); an outside link gets
 * `rel="noopener noreferrer"`; an unsafe one draws its children without a link.
 */
export function ShopLink({ href, children, ...props }: Readonly<ShopLinkProps>) {
  const { slots } = useShop();
  const link = safeLink(href);
  if (!link) return <span className={props.className}>{children}</span>;
  if (link.external || !link.href.startsWith('/')) {
    return (
      <a href={link.href} rel={link.external ? 'noopener noreferrer' : undefined} {...props}>
        {children}
      </a>
    );
  }
  const Link = slots.Link;
  if (Link) {
    return (
      <Link href={link.href} {...props}>
        {children}
      </Link>
    );
  }
  return (
    <a href={link.href} {...props}>
      {children}
    </a>
  );
}

/** `aria-current="page"` for the link to the page being shown. */
export function currentPage(path: string, href: string): 'page' | undefined {
  const target = href.split(/[?#]/)[0];
  return target === path ? 'page' : undefined;
}
