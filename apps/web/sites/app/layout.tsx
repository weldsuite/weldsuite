import type { Metadata } from "next";
import "@weldsuite/ui/globals.css";

export const metadata: Metadata = {
  title: "Customer Site",
  description: "Website created with WeldSuite",
};

// Google Fonts URL with all fonts and weights
const googleFontsUrl = 'https://fonts.googleapis.com/css2?family=Alegreya:wght@400;500;600;700&family=Archivo:wght@400;500;600;700&family=Arvo:wght@400;700&family=Barlow:wght@400;500;600;700&family=Bebas+Neue&family=Bitter:wght@400;500;600;700&family=Bricolage+Grotesque:wght@400;500;600;700&family=Cabin:wght@400;500;600;700&family=Cormorant:wght@400;500;600;700&family=Crimson+Text:wght@400;600;700&family=DM+Sans:wght@400;500;600;700&family=EB+Garamond:wght@400;500;600;700&family=Exo+2:wght@400;500;600;700&family=Figtree:wght@400;500;600;700&family=Heebo:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=Josefin+Sans:wght@400;500;600;700&family=Karla:wght@400;500;600;700&family=Lato:wght@400;700&family=Lexend:wght@400;500;600;700&family=Libre+Baskerville:wght@400;700&family=Libre+Franklin:wght@400;500;600;700&family=Manrope:wght@400;500;600;700&family=Merriweather:wght@400;700&family=Montserrat:wght@400;500;600;700&family=Mulish:wght@400;500;600;700&family=Noto+Sans:wght@400;500;600;700&family=Nunito:wght@400;500;600;700&family=Open+Sans:wght@400;500;600;700&family=Oswald:wght@400;500;600;700&family=Outfit:wght@400;500;600;700&family=PT+Sans:wght@400;700&family=Playfair+Display:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Poppins:wght@400;500;600;700&family=Quicksand:wght@400;500;600;700&family=Raleway:wght@400;500;600;700&family=Red+Hat+Display:wght@400;500;600;700&family=Roboto:wght@400;500;700&family=Rubik:wght@400;500;600;700&family=Sora:wght@400;500;600;700&family=Source+Sans+3:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&family=Spectral:wght@400;500;600;700&family=Ubuntu:wght@400;500;700&family=Vollkorn:wght@400;500;600;700&family=Work+Sans:wght@400;500;600;700&family=Yanone+Kaffeesatz:wght@400;500;600;700&display=swap';

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href={googleFontsUrl} rel="stylesheet" />
      </head>
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}