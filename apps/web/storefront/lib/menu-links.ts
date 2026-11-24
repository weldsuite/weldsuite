import { safeLink, type MenuLink, type PublishedPage } from '@weldsuite/storefront-theme';

/**
 * A menu link as a path of this shop (or an outside URL). Products and
 * categories link by id; their pages accept an id or a slug and redirect an
 * id to the slug. A page links by its storefront id to `/pages/<slug>`, and
 * to nothing when it is not among the published (visible) pages.
 */
export function resolveMenuLink(link: MenuLink, pages: ReadonlyArray<Pick<PublishedPage, 'id' | 'slug'>>): string | null {
  switch (link.type) {
    case 'home':
      return '/';
    case 'cart':
      return '/cart';
    case 'account':
      return '/account';
    case 'search':
      return '/search';
    case 'catalog':
      return '/products';
    case 'category':
      return link.id ? `/categories/${encodeURIComponent(link.id)}` : null;
    case 'product':
      return link.id ? `/products/${encodeURIComponent(link.id)}` : null;
    case 'page': {
      const page = pages.find((candidate) => candidate.id === link.id);
      return page ? `/pages/${encodeURIComponent(page.slug)}` : null;
    }
    case 'url':
      return safeLink(link.url)?.href ?? null;
    default:
      return null;
  }
}
