/// <reference types="vite/client" />
import { HeadContent, Outlet, ScriptOnce, Scripts, createRootRoute, redirect } from '@tanstack/react-router';
import { AuthProvider, signInRedirect } from '@/lib/auth-client';
import { Toaster } from 'sonner';
import { ThemeProvider, themeBootstrapScript } from '@/components/shell/theme';
import { getAdminSession } from '@/lib/session';
import appCss from '@/app/globals.css?url';

export const Route = createRootRoute({
  // Every page needs a session (what `middleware.ts` did); who may see
  // the console is decided by the `_admin` layout below it.
  beforeLoad: async ({ location }) => {
    // The sign-in page itself, and the Kubernetes build's sign-in endpoints.
    if (location.pathname === '/sign-in' || location.pathname.startsWith('/sign-in/') || location.pathname.startsWith('/auth/')) {
      return { identity: null };
    }
    const session = await getAdminSession();
    if (!session.signedIn) {
      throw redirect(signInRedirect(location.href));
    }
    return { identity: session.identity };
  },
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'WeldSuite Admin' },
      { name: 'description', content: 'WeldSuite internal administration' },
      { name: 'robots', content: 'noindex, nofollow' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
  component: Outlet,
});

function RootDocument({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Set the theme class before first paint — see components/shell/theme.tsx. */}
        <ScriptOnce>{themeBootstrapScript}</ScriptOnce>
        <HeadContent />
      </head>
      <body>
        <AuthProvider>
          <ThemeProvider>
            {children}
            <Toaster />
          </ThemeProvider>
        </AuthProvider>
        <Scripts />
      </body>
    </html>
  );
}
