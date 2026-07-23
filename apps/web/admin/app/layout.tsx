import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import { Toaster } from 'sonner';
import { Sidebar } from '@/components/sidebar';
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
      <html lang="en">
        <body>
          <div className="flex h-screen">
            {identity && (
              <Sidebar
                name={identity.name}
                email={identity.email}
                role={identity.role}
              />
            )}
            <main className="flex-1 overflow-hidden">{children}</main>
          </div>
          <Toaster />
        </body>
      </html>
    </ClerkProvider>
  );
}
