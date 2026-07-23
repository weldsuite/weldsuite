"use client";

import React from 'react';
import { Search, ShoppingBag, User, ChevronDown, X, Menu } from 'lucide-react';

interface NavMenuItem {
  label: string;
  href: string;
  isActive?: boolean;
}

interface NavbarLuxurySectionProps {
  // Announcement Bar
  showAnnouncement?: boolean;
  announcementText?: string;
  showCountrySelector?: boolean;
  countryLabel?: string;
  currencyLabel?: string;

  // Logo Section
  logo?: string;
  logoText?: string;
  logoFontSize?: number;
  logoLetterSpacing?: number;
  logoFontWeight?: string;

  // Navigation
  menuItems?: NavMenuItem[];
  activeMenuStyle?: 'underline' | 'bold' | 'none';

  // Icons
  showSearch?: boolean;
  showCart?: boolean;
  showAccount?: boolean;
  iconSize?: number;
  iconLayout?: 'search-left' | 'all-left' | 'all-right' | 'split-icons' | 'centered-icons';

  // Colors
  backgroundColor?: string;
  textColor?: string;
  announcementBgColor?: string;
  announcementTextColor?: string;
  accentColor?: string;

  // Spacing
  announcementPaddingY?: number;
  logoPaddingY?: number;
  navPaddingY?: number;
  paddingX?: number;

  // Other
  stickyHeader?: boolean;
  showNavBorder?: boolean;
  navBorderColor?: string;

  store?: any;
  mode?: string;
}

export function NavbarLuxurySection({
  // Announcement Bar
  showAnnouncement = true,
  announcementText = 'FREE EU & US SHIPPING ON ALL ORDERS OVER €50',
  showCountrySelector = true,
  countryLabel = 'Netherlands',
  currencyLabel = 'EUR €',

  // Logo Section
  logo,
  logoText = 'DESMIRAGES',
  logoFontSize = 20,
  logoLetterSpacing = 6,
  logoFontWeight = '400',

  // Navigation
  menuItems = [
    { label: 'HOME', href: '/', isActive: true },
    { label: 'SHOP ALL', href: '/shop' },
    { label: 'THE RESORT', href: '/resort' },
    { label: 'THE COUNTRY CLUB', href: '/country-club' },
    { label: 'THE WELLNESS', href: '/wellness' },
    { label: 'CONTACT', href: '/contact' },
    { label: 'ABOUT US', href: '/about' },
  ],
  activeMenuStyle = 'underline',

  // Icons
  showSearch = true,
  showCart = true,
  showAccount = true,
  iconSize = 20,
  iconLayout = 'search-left',

  // Colors
  backgroundColor = '#1a1f1a',
  textColor = '#ffffff',
  announcementBgColor = '#1a1f1a',
  announcementTextColor = '#ffffff',
  accentColor = '#ffffff',

  // Spacing
  announcementPaddingY = 12,
  logoPaddingY = 23,
  navPaddingY = 16,
  paddingX = 40,

  // Other
  stickyHeader = true,
  showNavBorder = true,
  navBorderColor = '#333333',

  store,
  mode = 'live'
}: NavbarLuxurySectionProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = React.useState(false);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [countryOpen, setCountryOpen] = React.useState(false);

  const displayLogo = logo || store?.logo;
  const displayLogoText = logoText || store?.name || 'YOUR BRAND';

  return (
    <header className={`w-full ${stickyHeader ? 'sticky top-0 z-40' : ''}`}>
      {/* Announcement Bar */}
      {showAnnouncement && (
        <div
          style={{
            backgroundColor: announcementBgColor,
            paddingTop: `${announcementPaddingY}px`,
            paddingBottom: `${announcementPaddingY}px`,
            paddingLeft: `${paddingX}px`,
            paddingRight: `${paddingX}px`,
          }}
        >
          <div className="flex items-center justify-between max-w-7xl mx-auto">
            {/* Spacer for centering */}
            <div className="flex-1" />

            {/* Announcement Text */}
            <p
              className="text-xs tracking-wider uppercase text-center"
              style={{ color: announcementTextColor }}
            >
              {announcementText}
            </p>

            {/* Country/Currency Selector */}
            <div className="flex-1 flex justify-end">
              {showCountrySelector && (
                <button
                  className="flex items-center gap-1 text-xs hover:opacity-70 transition-opacity"
                  style={{ color: announcementTextColor }}
                  onClick={() => setCountryOpen(!countryOpen)}
                >
                  <span>{countryLabel} ({currencyLabel})</span>
                  <ChevronDown className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Logo Section */}
      <div
        style={{
          backgroundColor,
          paddingTop: `${logoPaddingY}px`,
          paddingBottom: `${logoPaddingY}px`,
          paddingLeft: `${paddingX}px`,
          paddingRight: `${paddingX}px`,
        }}
      >
        <div className="flex items-center justify-between max-w-7xl mx-auto">
          {/* Icon Layout: search-left (default) - Search left, Account+Cart right */}
          {iconLayout === 'search-left' && (
            <>
              {/* Left - Search */}
              <div className="flex-1 flex items-center">
                {showSearch && !searchOpen && (
                  <button
                    className="p-1 hover:opacity-70 transition-opacity"
                    onClick={() => setSearchOpen(true)}
                    aria-label="Search"
                  >
                    <Search style={{ width: iconSize, height: iconSize, color: textColor }} />
                  </button>
                )}
                {searchOpen && (
                  <div className="flex items-center gap-2 flex-1 max-w-xs">
                    <Search style={{ width: iconSize, height: iconSize, color: textColor }} />
                    <input
                      type="text"
                      placeholder="Search..."
                      autoFocus
                      className="bg-transparent border-b border-white/30 py-1 text-sm focus:outline-none flex-1"
                      style={{ color: textColor }}
                    />
                    <button onClick={() => setSearchOpen(false)}>
                      <X style={{ width: iconSize, height: iconSize, color: textColor }} />
                    </button>
                  </div>
                )}
              </div>

              {/* Center - Logo */}
              <div className="flex-1 flex justify-center">
                {displayLogo ? (
                  <a href="/">
                    <img src={displayLogo} alt={displayLogoText} className="h-8 w-auto object-contain" />
                  </a>
                ) : (
                  <a href="/" className="tracking-widest" style={{ color: textColor, fontSize: `${logoFontSize}px`, fontWeight: logoFontWeight, letterSpacing: `${logoLetterSpacing}px` }}>
                    {displayLogoText}
                  </a>
                )}
              </div>

              {/* Right - Account & Cart */}
              <div className="flex-1 flex items-center justify-end gap-4">
                {showAccount && (
                  <a href="/account" className="p-1 hover:opacity-70 transition-opacity hidden sm:block" aria-label="Account">
                    <User style={{ width: iconSize, height: iconSize, color: textColor }} />
                  </a>
                )}
                {showCart && (
                  <a href="/cart" className="p-1 hover:opacity-70 transition-opacity" aria-label="Cart">
                    <ShoppingBag style={{ width: iconSize, height: iconSize, color: textColor }} />
                  </a>
                )}
                <button className="p-1 hover:opacity-70 transition-opacity lg:hidden" onClick={() => setMobileMenuOpen(!mobileMenuOpen)} aria-label="Menu">
                  {mobileMenuOpen ? <X style={{ width: iconSize + 4, height: iconSize + 4, color: textColor }} /> : <Menu style={{ width: iconSize + 4, height: iconSize + 4, color: textColor }} />}
                </button>
              </div>
            </>
          )}

          {/* Icon Layout: all-left - All icons on left, Logo on right */}
          {iconLayout === 'all-left' && (
            <>
              {/* Left - All Icons */}
              <div className="flex-1 flex items-center gap-4">
                {showSearch && !searchOpen && (
                  <button className="p-1 hover:opacity-70 transition-opacity" onClick={() => setSearchOpen(true)} aria-label="Search">
                    <Search style={{ width: iconSize, height: iconSize, color: textColor }} />
                  </button>
                )}
                {searchOpen && (
                  <div className="flex items-center gap-2 flex-1 max-w-xs">
                    <Search style={{ width: iconSize, height: iconSize, color: textColor }} />
                    <input type="text" placeholder="Search..." autoFocus className="bg-transparent border-b border-white/30 py-1 text-sm focus:outline-none flex-1" style={{ color: textColor }} />
                    <button onClick={() => setSearchOpen(false)}><X style={{ width: iconSize, height: iconSize, color: textColor }} /></button>
                  </div>
                )}
                {showAccount && !searchOpen && (
                  <a href="/account" className="p-1 hover:opacity-70 transition-opacity hidden sm:block" aria-label="Account">
                    <User style={{ width: iconSize, height: iconSize, color: textColor }} />
                  </a>
                )}
                {showCart && !searchOpen && (
                  <a href="/cart" className="p-1 hover:opacity-70 transition-opacity" aria-label="Cart">
                    <ShoppingBag style={{ width: iconSize, height: iconSize, color: textColor }} />
                  </a>
                )}
              </div>

              {/* Center - Logo */}
              <div className="flex-1 flex justify-center">
                {displayLogo ? (
                  <a href="/"><img src={displayLogo} alt={displayLogoText} className="h-8 w-auto object-contain" /></a>
                ) : (
                  <a href="/" className="tracking-widest" style={{ color: textColor, fontSize: `${logoFontSize}px`, fontWeight: logoFontWeight, letterSpacing: `${logoLetterSpacing}px` }}>{displayLogoText}</a>
                )}
              </div>

              {/* Right - Mobile Menu only */}
              <div className="flex-1 flex items-center justify-end">
                <button className="p-1 hover:opacity-70 transition-opacity lg:hidden" onClick={() => setMobileMenuOpen(!mobileMenuOpen)} aria-label="Menu">
                  {mobileMenuOpen ? <X style={{ width: iconSize + 4, height: iconSize + 4, color: textColor }} /> : <Menu style={{ width: iconSize + 4, height: iconSize + 4, color: textColor }} />}
                </button>
              </div>
            </>
          )}

          {/* Icon Layout: all-right - Logo left, All icons on right */}
          {iconLayout === 'all-right' && (
            <>
              {/* Left - Empty spacer */}
              <div className="flex-1" />

              {/* Center - Logo */}
              <div className="flex-1 flex justify-center">
                {displayLogo ? (
                  <a href="/"><img src={displayLogo} alt={displayLogoText} className="h-8 w-auto object-contain" /></a>
                ) : (
                  <a href="/" className="tracking-widest" style={{ color: textColor, fontSize: `${logoFontSize}px`, fontWeight: logoFontWeight, letterSpacing: `${logoLetterSpacing}px` }}>{displayLogoText}</a>
                )}
              </div>

              {/* Right - All Icons */}
              <div className="flex-1 flex items-center justify-end gap-4">
                {showSearch && !searchOpen && (
                  <button className="p-1 hover:opacity-70 transition-opacity" onClick={() => setSearchOpen(true)} aria-label="Search">
                    <Search style={{ width: iconSize, height: iconSize, color: textColor }} />
                  </button>
                )}
                {searchOpen && (
                  <div className="flex items-center gap-2 flex-1 max-w-xs">
                    <Search style={{ width: iconSize, height: iconSize, color: textColor }} />
                    <input type="text" placeholder="Search..." autoFocus className="bg-transparent border-b border-white/30 py-1 text-sm focus:outline-none flex-1" style={{ color: textColor }} />
                    <button onClick={() => setSearchOpen(false)}><X style={{ width: iconSize, height: iconSize, color: textColor }} /></button>
                  </div>
                )}
                {showAccount && (
                  <a href="/account" className="p-1 hover:opacity-70 transition-opacity hidden sm:block" aria-label="Account">
                    <User style={{ width: iconSize, height: iconSize, color: textColor }} />
                  </a>
                )}
                {showCart && (
                  <a href="/cart" className="p-1 hover:opacity-70 transition-opacity" aria-label="Cart">
                    <ShoppingBag style={{ width: iconSize, height: iconSize, color: textColor }} />
                  </a>
                )}
                <button className="p-1 hover:opacity-70 transition-opacity lg:hidden" onClick={() => setMobileMenuOpen(!mobileMenuOpen)} aria-label="Menu">
                  {mobileMenuOpen ? <X style={{ width: iconSize + 4, height: iconSize + 4, color: textColor }} /> : <Menu style={{ width: iconSize + 4, height: iconSize + 4, color: textColor }} />}
                </button>
              </div>
            </>
          )}

          {/* Icon Layout: split-icons - Search+Account left, Cart right */}
          {iconLayout === 'split-icons' && (
            <>
              {/* Left - Search & Account */}
              <div className="flex-1 flex items-center gap-4">
                {showSearch && !searchOpen && (
                  <button className="p-1 hover:opacity-70 transition-opacity" onClick={() => setSearchOpen(true)} aria-label="Search">
                    <Search style={{ width: iconSize, height: iconSize, color: textColor }} />
                  </button>
                )}
                {searchOpen && (
                  <div className="flex items-center gap-2 flex-1 max-w-xs">
                    <Search style={{ width: iconSize, height: iconSize, color: textColor }} />
                    <input type="text" placeholder="Search..." autoFocus className="bg-transparent border-b border-white/30 py-1 text-sm focus:outline-none flex-1" style={{ color: textColor }} />
                    <button onClick={() => setSearchOpen(false)}><X style={{ width: iconSize, height: iconSize, color: textColor }} /></button>
                  </div>
                )}
                {showAccount && !searchOpen && (
                  <a href="/account" className="p-1 hover:opacity-70 transition-opacity hidden sm:block" aria-label="Account">
                    <User style={{ width: iconSize, height: iconSize, color: textColor }} />
                  </a>
                )}
              </div>

              {/* Center - Logo */}
              <div className="flex-1 flex justify-center">
                {displayLogo ? (
                  <a href="/"><img src={displayLogo} alt={displayLogoText} className="h-8 w-auto object-contain" /></a>
                ) : (
                  <a href="/" className="tracking-widest" style={{ color: textColor, fontSize: `${logoFontSize}px`, fontWeight: logoFontWeight, letterSpacing: `${logoLetterSpacing}px` }}>{displayLogoText}</a>
                )}
              </div>

              {/* Right - Cart only */}
              <div className="flex-1 flex items-center justify-end gap-4">
                {showCart && (
                  <a href="/cart" className="p-1 hover:opacity-70 transition-opacity" aria-label="Cart">
                    <ShoppingBag style={{ width: iconSize, height: iconSize, color: textColor }} />
                  </a>
                )}
                <button className="p-1 hover:opacity-70 transition-opacity lg:hidden" onClick={() => setMobileMenuOpen(!mobileMenuOpen)} aria-label="Menu">
                  {mobileMenuOpen ? <X style={{ width: iconSize + 4, height: iconSize + 4, color: textColor }} /> : <Menu style={{ width: iconSize + 4, height: iconSize + 4, color: textColor }} />}
                </button>
              </div>
            </>
          )}

          {/* Icon Layout: centered-icons - Logo top, icons below (stacked) */}
          {iconLayout === 'centered-icons' && (
            <>
              {/* Left - Empty */}
              <div className="flex-1" />

              {/* Center - Logo + Icons stacked */}
              <div className="flex-1 flex flex-col items-center gap-3">
                {displayLogo ? (
                  <a href="/"><img src={displayLogo} alt={displayLogoText} className="h-8 w-auto object-contain" /></a>
                ) : (
                  <a href="/" className="tracking-widest" style={{ color: textColor, fontSize: `${logoFontSize}px`, fontWeight: logoFontWeight, letterSpacing: `${logoLetterSpacing}px` }}>{displayLogoText}</a>
                )}
                <div className="flex items-center gap-5">
                  {showSearch && !searchOpen && (
                    <button className="p-1 hover:opacity-70 transition-opacity" onClick={() => setSearchOpen(true)} aria-label="Search">
                      <Search style={{ width: iconSize, height: iconSize, color: textColor }} />
                    </button>
                  )}
                  {showAccount && (
                    <a href="/account" className="p-1 hover:opacity-70 transition-opacity hidden sm:block" aria-label="Account">
                      <User style={{ width: iconSize, height: iconSize, color: textColor }} />
                    </a>
                  )}
                  {showCart && (
                    <a href="/cart" className="p-1 hover:opacity-70 transition-opacity" aria-label="Cart">
                      <ShoppingBag style={{ width: iconSize, height: iconSize, color: textColor }} />
                    </a>
                  )}
                </div>
              </div>

              {/* Right - Mobile Menu */}
              <div className="flex-1 flex items-center justify-end">
                <button className="p-1 hover:opacity-70 transition-opacity lg:hidden" onClick={() => setMobileMenuOpen(!mobileMenuOpen)} aria-label="Menu">
                  {mobileMenuOpen ? <X style={{ width: iconSize + 4, height: iconSize + 4, color: textColor }} /> : <Menu style={{ width: iconSize + 4, height: iconSize + 4, color: textColor }} />}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Navigation Bar - Desktop */}
      <nav
        className="hidden lg:block"
        style={{
          backgroundColor,
          paddingTop: `${navPaddingY}px`,
          paddingBottom: `${navPaddingY}px`,
          paddingLeft: `${paddingX}px`,
          paddingRight: `${paddingX}px`,
          borderTop: showNavBorder ? `1px solid ${navBorderColor}` : 'none',
        }}
      >
        <div className="flex items-center justify-center gap-8 max-w-7xl mx-auto">
          {menuItems.map((item, idx) => (
            <a
              key={idx}
              href={item.href}
              className="relative text-xs tracking-wider uppercase hover:opacity-70 transition-opacity py-1"
              style={{ color: textColor }}
            >
              {item.label}
              {item.isActive && activeMenuStyle === 'underline' && (
                <span
                  className="absolute bottom-0 left-0 right-0 h-0.5"
                  style={{ backgroundColor: accentColor }}
                />
              )}
            </a>
          ))}
        </div>
      </nav>

      {/* Mobile Navigation */}
      {mobileMenuOpen && (
        <div
          className="lg:hidden"
          style={{ backgroundColor }}
        >
          <nav
            className="py-4"
            style={{
              paddingLeft: `${paddingX}px`,
              paddingRight: `${paddingX}px`,
              borderTop: `1px solid ${navBorderColor}`,
            }}
          >
            {menuItems.map((item, idx) => (
              <a
                key={idx}
                href={item.href}
                className="block py-3 text-sm tracking-wider uppercase hover:opacity-70 transition-opacity"
                style={{
                  color: textColor,
                  borderBottom: idx < menuItems.length - 1 ? `1px solid ${navBorderColor}` : 'none',
                }}
              >
                {item.label}
              </a>
            ))}
          </nav>

          {/* Mobile Account Link */}
          {showAccount && (
            <div
              className="py-4 border-t"
              style={{
                paddingLeft: `${paddingX}px`,
                paddingRight: `${paddingX}px`,
                borderColor: navBorderColor,
              }}
            >
              <a
                href="/account"
                className="flex items-center gap-2 text-sm tracking-wider uppercase hover:opacity-70"
                style={{ color: textColor }}
              >
                <User style={{ width: iconSize, height: iconSize }} />
                <span>Account</span>
              </a>
            </div>
          )}
        </div>
      )}
    </header>
  );
}
