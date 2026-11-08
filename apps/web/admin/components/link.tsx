import { Link as RouterLink, useLocation } from '@tanstack/react-router';
import type { AnchorHTMLAttributes } from 'react';

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  href: string;
  /** Accepted for next/link compatibility; TanStack Router doesn't prefetch here. */
  prefetch?: boolean;
  replace?: boolean;
  /** next/link's `scroll={false}`: keep the scroll position. */
  scroll?: boolean;
};

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * next/link's API on TanStack Router, so components keep writing
 * `<Link href="/workspaces/ws_1?tab=billing">`. An internal href is split into
 * the path, search and hash the router navigates with (relative hrefs resolve
 * against the current page); anything with a scheme is a plain anchor.
 */
export default function Link({ href, prefetch: _prefetch, replace, scroll, children, ...rest }: Readonly<LinkProps>) {
  const pathname = useLocation({ select: (location) => location.pathname });
  if (EXTERNAL.test(href)) {
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  }

  const url = new URL(href, `http://admin.local${pathname}`);
  return (
    <RouterLink
      // The path is a concrete URL path, not a route id: the router matches it at runtime.
      to={url.pathname as never}
      search={Object.fromEntries(url.searchParams) as never}
      hash={url.hash ? url.hash.slice(1) : undefined}
      replace={replace}
      resetScroll={scroll === false ? false : undefined}
      {...rest}
    >
      {children}
    </RouterLink>
  );
}
