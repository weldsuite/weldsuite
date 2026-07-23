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
  ({ href, replace, children, prefetch, scroll, ...rest }, ref) => {
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
        {...(rest as any)}
      >
        {children}
      </TanStackLink>
    );
  },
);

Link.displayName = 'Link';
