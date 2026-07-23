import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Join Meeting — WeldSuite',
  description: 'Join a WeldMeet video meeting',
};

// Synchronously toggle the `.dark` class based on the visitor's system
// preference, before React hydrates — prevents a flash of the wrong theme.
const themeScript = `
  (function() {
    try {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var apply = function(isDark) {
        document.documentElement.classList.toggle('dark', isDark);
      };
      apply(mq.matches);
      mq.addEventListener('change', function(e) { apply(e.matches); });
    } catch (e) {}
  })();
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="antialiased bg-background text-foreground">{children}</body>
    </html>
  );
}
