/**
 * The small router surface the portal pages use (`Link`, `useRouter`,
 * `useParams`, `useSearchParams`), on react-router. Same shape as the
 * platform's `@/lib/router`, so the pages read the same in both apps.
 */

import { forwardRef, useMemo, type ComponentPropsWithoutRef } from 'react';
import {
  Link as RouterLink,
  useNavigate,
  useParams as useRouterParams,
  useSearchParams as useRouterSearchParams,
} from 'react-router-dom';

type LinkProps = Omit<ComponentPropsWithoutRef<typeof RouterLink>, 'to'> & { href: string };

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link({ href, ...props }, ref) {
  return <RouterLink ref={ref} to={href} {...props} />;
});

export function useRouter() {
  const navigate = useNavigate();
  return useMemo(
    () => ({
      push: (href: string) => navigate(href),
      replace: (href: string) => navigate(href, { replace: true }),
      back: () => navigate(-1),
    }),
    [navigate],
  );
}

export function useParams<T extends Record<string, string | undefined>>(): T {
  return useRouterParams() as T;
}

/** Read-only search params, like `next/navigation`. */
export function useSearchParams(): URLSearchParams {
  return useRouterSearchParams()[0];
}
