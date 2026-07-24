import { Link as TanStackLink } from '@tanstack/react-router';
import { forwardRef } from 'react';

interface LinkProps extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  href: string;
  replace?: boolean;
  scroll?: boolean;
  prefetch?: boolean;
  children?: React.ReactNode;
}

/**
 * Compat layer: drop-in replacement for `<Link>` from `next/link`.
 * Maps `href` prop to TanStack Router's `to` prop.
 */
export const Link = forwardRef<HTMLAnchorElement, LinkProps>(
  (
    {
      href,
      replace,
      children,
      // Destructured only to keep them out of `...rest` (they're not valid
      // DOM anchor attributes) — TanStack Router doesn't need them either.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      prefetch,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      scroll,
      ...rest
    },
    ref,
  ) => {
    // Handle external links
    if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:') || href.startsWith('tel:')) {
      return (
        <a ref={ref} href={href} {...rest}>
          {children}
        </a>
      );
    }

    return (
      <TanStackLink
        ref={ref}
        to={href}
        replace={replace}
        // TanStackLink's props are inferred per-route (heavily generic); the
        // leftover DOM anchor attributes in `rest` don't structurally match
        // any single inferred route shape, so a precise cast isn't possible here.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {...(rest as any)}
      >
        {children}
      </TanStackLink>
    );
  },
);

Link.displayName = 'Link';
