import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Toaster } from "sonner";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Book a Meeting",
  description: "Schedule a meeting at a time that works for you.",
};

const themeInit = `
(function() {
  try {
    var mql = window.matchMedia('(prefers-color-scheme: dark)');
    function apply(e) {
      document.documentElement.classList.toggle('dark', e.matches);
    }
    apply(mql);
    if (mql.addEventListener) mql.addEventListener('change', apply);
    else if (mql.addListener) mql.addListener(apply);
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
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className={inter.className}>
        {children}
        <Toaster position="top-center" richColors />
      </body>
    </html>
  );
}
