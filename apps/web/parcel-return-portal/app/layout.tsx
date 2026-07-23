import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Toaster } from "sonner";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Returns Portal - Easy Returns & Exchanges",
  description: "Hassle-free returns and exchanges. Track your return, print labels, and get refunds quickly.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        <div className="min-h-screen flex items-center justify-center p-4" style={{ backgroundColor: '#FDFDFD' }}>
          <div className="bg-white rounded-2xl max-w-5xl w-full overflow-hidden border border-gray-200">
            {/* Main Content Grid */}
            <div className="grid md:grid-cols-2">
              {/* Left Column - Gray Area (Static) */}
              <div className="h-full relative flex flex-col justify-end" style={{ backgroundColor: '#F7F7F7' }}>
                {/* Product Information - Bottom Left */}
                <div className="p-8">
                  <div className="space-y-2">
                    <h3 className="text-base font-semibold text-gray-900" style={{ fontFamily: 'Inter, sans-serif' }}>
                      Classic White Sneakers
                    </h3>
                    <p className="text-sm text-gray-600" style={{ fontFamily: 'Inter, sans-serif' }}>
                      Size: US 10 / EU 44
                    </p>
                    <p className="text-sm text-gray-900 font-mono">
                      $89.99
                    </p>
                  </div>
                </div>
              </div>

              {/* Right Column - Dynamic Content Area */}
              <div className="flex flex-col relative border-l border-gray-200 transition-container fade-in">
                {children}
              </div>
            </div>
          </div>
        </div>
        <Toaster position="top-center" richColors />
      </body>
    </html>
  );
}