import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import { Toaster } from 'sonner';
import { AdminShell } from '@/components/shell/admin-shell';
import { ThemeProvider, themeBootstrapScript } from '@/components/shell/theme';
import { getAdminIdentity } from '@/lib/auth';
import './globals.css';

export const metadata: Metadata = {
  title: 'WeldSuite Admin',
  description: 'WeldSuite internal administration',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const identity = await getAdminIdentity();

  return (
    <ClerkProvider>
      <html lang="en" suppressHydrationWarning>
        <head>
          {/* Set the theme class before first paint — see components/shell/theme.tsx. */}
          <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
        </head>
        <body>
          <ThemeProvider>
            {identity ? (
              <AdminShell name={identity.name} email={identity.email} role={identity.role}>
                {children}
              </AdminShell>
            ) : (
              // Signed out (/unauthorized, Clerk redirects) — no shell to hang
              // navigation off, so render the page bare on the chrome surface.
              <div className="h-screen overflow-auto bg-background">{children}</div>
            )}
            <Toaster />
          </ThemeProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
