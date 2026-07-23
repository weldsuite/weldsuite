"use client";

import React from 'react';
import { Menu, X, ShoppingCart, Search, User, ChevronDown, ChevronRight } from 'lucide-react';

interface MegamenuItem {
  label: string;
  href: string;
  description?: string;
}

interface NavMenuItem {
  label: string;
  href: string;
  featured?: boolean;
  children?: MegamenuItem[];
  megamenuImage?: string;
  megamenuImageAlt?: string;
}

interface NavbarShopifySectionProps {
  logo?: string;
  logoText?: string;
  logoPosition?: 'left' | 'center';
  menuType?: 'dropdown' | 'megamenu';
  menuItems?: NavMenuItem[];
  backgroundColor?: string;
  textColor?: string;
  hoverColor?: string;
  showSearch?: boolean;
  searchStyle?: 'icon' | 'bar';
  showCart?: boolean;
  showAccount?: boolean;
  stickyHeader?: boolean;
  stickyMode?: 'none' | 'always' | 'onScrollUp' | 'alwaysReduce';
  stickyBackgroundColor?: string;
  stickyTextColor?: string;
  showBorder?: boolean;
  borderColor?: string;
  paddingY?: number;
  paddingX?: number;
  logoHeight?: number;
  reducedLogoHeight?: number;
  megamenuStyle?: 'full-width' | 'dropdown';
  megamenuColumns?: number;
  megamenuBackgroundColor?: string;
  megamenuTextColor?: string;
  megamenuShowImages?: boolean;
  megamenuShowDescriptions?: boolean;
  mobileBreakpoint?: 'sm' | 'md' | 'lg';
  mobileMenuStyle?: 'drawer' | 'dropdown';
  store?: any;
  mode?: string;
}

export function NavbarShopifySection({
  logo,
  logoText,
  logoPosition = 'left',
  menuType = 'megamenu',
  menuItems = [
    {
      label: 'Shop',
      href: '/shop',
      featured: true,
      children: [
        { label: 'New Arrivals', href: '/collections/new-arrivals', description: 'Check out our latest products' },
        { label: 'Best Sellers', href: '/collections/best-sellers', description: 'Our most popular items' },
        { label: 'Sale', href: '/collections/sale', description: 'Great deals on select items' },
        { label: 'All Products', href: '/collections/all', description: 'Browse our full catalog' }
      ],
      megamenuImage: '',
      megamenuImageAlt: 'Featured Collection'
    },
    {
      label: 'Collections',
      href: '/collections',
      children: [
        { label: 'Summer Collection', href: '/collections/summer' },
        { label: 'Winter Collection', href: '/collections/winter' },
        { label: 'Accessories', href: '/collections/accessories' },
        { label: 'Gift Cards', href: '/gift-cards' }
      ]
    },
    { label: 'About', href: '/about' },
    { label: 'Contact', href: '/contact' }
  ],
  backgroundColor = '#ffffff',
  textColor = '#121212',
  hoverColor = '#000000',
  showSearch = true,
  searchStyle = 'icon',
  showCart = true,
  showAccount = true,
  stickyHeader = true,
  stickyMode = 'always',
  stickyBackgroundColor = '#ffffff',
  stickyTextColor = '#121212',
  showBorder = true,
  borderColor = '#e5e5e5',
  paddingY = 16,
  paddingX = 40,
  logoHeight = 32,
  reducedLogoHeight = 24,
  megamenuStyle = 'full-width',
  megamenuColumns = 4,
  megamenuBackgroundColor = '#ffffff',
  megamenuTextColor = '#121212',
  megamenuShowImages = true,
  megamenuShowDescriptions = true,
  mobileBreakpoint = 'md',
  mobileMenuStyle = 'drawer',
  store,
  mode = 'live'
}: NavbarShopifySectionProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = React.useState(false);
  const [activeMenu, setActiveMenu] = React.useState<string | null>(null);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [isScrolled, setIsScrolled] = React.useState(false);
  const [isVisible, setIsVisible] = React.useState(true);
  const [lastScrollY, setLastScrollY] = React.useState(0);
  const menuRef = React.useRef<HTMLDivElement>(null);

  const displayLogo = logo || store?.logo;
  const displayLogoText = logoText || store?.name || 'Your Store';

  // Handle scroll behavior
  React.useEffect(() => {
    if (stickyMode === 'none' || mode === 'builder') return;

    const handleScroll = () => {
      const currentScrollY = window.scrollY;
      setIsScrolled(currentScrollY > 50);

      if (stickyMode === 'onScrollUp') {
        setIsVisible(currentScrollY < lastScrollY || currentScrollY < 100);
      }

      setLastScrollY(currentScrollY);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [lastScrollY, stickyMode, mode]);

  // Close menu when clicking outside
  React.useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setActiveMenu(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const isSticky = stickyMode === 'always' ||
                   stickyMode === 'alwaysReduce' ||
                   (stickyMode === 'onScrollUp' && isVisible);

  const currentLogoHeight = (stickyMode === 'alwaysReduce' && isScrolled)
    ? reducedLogoHeight
    : logoHeight;

  const currentBgColor = isScrolled && stickyHeader ? stickyBackgroundColor : backgroundColor;
  const currentTextColor = isScrolled && stickyHeader ? stickyTextColor : textColor;

  const breakpointClass = mobileBreakpoint === 'sm' ? 'sm' : mobileBreakpoint === 'lg' ? 'lg' : 'md';

  const renderMegamenu = (item: NavMenuItem) => {
    if (!item.children || item.children.length === 0) return null;

    const showImage = megamenuShowImages && item.megamenuImage;
    const columnsClass = megamenuColumns === 2 ? 'grid-cols-2' :
                         megamenuColumns === 3 ? 'grid-cols-3' :
                         megamenuColumns === 4 ? 'grid-cols-4' : 'grid-cols-4';

    if (megamenuStyle === 'full-width') {
      return (
        <div
          className="absolute left-0 right-0 top-full w-screen shadow-lg border-t z-50 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200"
          style={{
            backgroundColor: megamenuBackgroundColor,
            borderColor: borderColor,
            marginLeft: 'calc(-50vw + 50%)',
            marginRight: 'calc(-50vw + 50%)'
          }}
        >
          <div
            className="max-w-7xl mx-auto py-8"
            style={{ paddingLeft: `${paddingX}px`, paddingRight: `${paddingX}px` }}
          >
            <div className={`grid ${columnsClass} gap-8`}>
              {/* Menu Items */}
              <div className={showImage ? 'col-span-3' : 'col-span-4'}>
                <div className={`grid ${showImage ? 'grid-cols-3' : columnsClass} gap-6`}>
                  {item.children.map((child, idx) => (
                    <a
                      key={idx}
                      href={child.href}
                      className="group/item block p-3 rounded-lg hover:bg-gray-50 transition-colors"
                    >
                      <span
                        className="block font-medium mb-1 group-hover/item:underline"
                        style={{ color: megamenuTextColor }}
                      >
                        {child.label}
                      </span>
                      {megamenuShowDescriptions && child.description && (
                        <span
                          className="block text-sm opacity-70"
                          style={{ color: megamenuTextColor }}
                        >
                          {child.description}
                        </span>
                      )}
                    </a>
                  ))}
                </div>
              </div>

              {/* Featured Image */}
              {showImage && (
                <div className="col-span-1">
                  <a href={item.href} className="block relative aspect-[4/5] rounded-lg overflow-hidden group/img">
                    <img
                      src={item.megamenuImage}
                      alt={item.megamenuImageAlt || item.label}
                      className="w-full h-full object-cover transition-transform duration-300 group-hover/img:scale-105"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent" />
                    <div className="absolute bottom-4 left-4 right-4">
                      <span className="text-white font-medium">{item.megamenuImageAlt || 'Shop Now'}</span>
                    </div>
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }

    // Dropdown style megamenu
    return (
      <div
        className="absolute left-0 top-full mt-1 min-w-[280px] rounded-lg shadow-lg border z-50 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200"
        style={{
          backgroundColor: megamenuBackgroundColor,
          borderColor: borderColor
        }}
      >
        <div className="py-3">
          {item.children.map((child, idx) => (
            <a
              key={idx}
              href={child.href}
              className="block px-4 py-2 hover:bg-gray-50 transition-colors"
            >
              <span
                className="block font-medium"
                style={{ color: megamenuTextColor }}
              >
                {child.label}
              </span>
              {megamenuShowDescriptions && child.description && (
                <span
                  className="block text-sm opacity-70"
                  style={{ color: megamenuTextColor }}
                >
                  {child.description}
                </span>
              )}
            </a>
          ))}
        </div>
      </div>
    );
  };

  const renderDesktopNav = () => (
    <div className={`hidden ${breakpointClass}:flex items-center gap-8`}>
      {menuItems.map((item, idx) => (
        <div key={idx} className="relative group">
          {item.children && item.children.length > 0 ? (
            <>
              <button
                className="flex items-center gap-1 py-2 font-medium transition-colors"
                style={{ color: currentTextColor }}
                onMouseEnter={() => setActiveMenu(item.label)}
              >
                {item.label}
                <ChevronDown className="w-4 h-4 transition-transform group-hover:rotate-180" />
              </button>
              {menuType === 'megamenu' ? renderMegamenu(item) : (
                <div
                  className="absolute left-0 top-full mt-1 min-w-[200px] rounded-lg shadow-lg border z-50 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 py-2"
                  style={{ backgroundColor: megamenuBackgroundColor, borderColor }}
                >
                  {item.children.map((child, childIdx) => (
                    <a
                      key={childIdx}
                      href={child.href}
                      className="block px-4 py-2 hover:bg-gray-50 transition-colors"
                      style={{ color: megamenuTextColor }}
                    >
                      {child.label}
                    </a>
                  ))}
                </div>
              )}
            </>
          ) : (
            <a
              href={item.href}
              className="py-2 font-medium transition-colors hover:opacity-70"
              style={{ color: currentTextColor }}
            >
              {item.label}
            </a>
          )}
        </div>
      ))}
    </div>
  );

  const renderMobileNav = () => {
    if (!mobileMenuOpen) return null;

    if (mobileMenuStyle === 'drawer') {
      return (
        <div className="fixed inset-0 z-50">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setMobileMenuOpen(false)}
          />

          {/* Drawer */}
          <div
            className="absolute top-0 right-0 h-full w-[320px] max-w-[80vw] shadow-xl overflow-y-auto"
            style={{ backgroundColor }}
          >
            <div className="flex items-center justify-between p-4 border-b" style={{ borderColor }}>
              <span className="font-semibold text-lg" style={{ color: textColor }}>Menu</span>
              <button
                onClick={() => setMobileMenuOpen(false)}
                className="p-2 rounded-full hover:bg-gray-100 transition-colors"
              >
                <X className="w-5 h-5" style={{ color: textColor }} />
              </button>
            </div>

            <nav className="py-4">
              {menuItems.map((item, idx) => (
                <div key={idx}>
                  {item.children && item.children.length > 0 ? (
                    <div>
                      <button
                        className="flex items-center justify-between w-full px-4 py-3 font-medium"
                        style={{ color: textColor }}
                        onClick={() => setActiveMenu(activeMenu === item.label ? null : item.label)}
                      >
                        {item.label}
                        <ChevronRight
                          className={`w-4 h-4 transition-transform ${activeMenu === item.label ? 'rotate-90' : ''}`}
                        />
                      </button>
                      {activeMenu === item.label && (
                        <div className="bg-gray-50 py-2">
                          {item.children.map((child, childIdx) => (
                            <a
                              key={childIdx}
                              href={child.href}
                              className="block px-8 py-2 text-sm"
                              style={{ color: textColor }}
                            >
                              {child.label}
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <a
                      href={item.href}
                      className="block px-4 py-3 font-medium"
                      style={{ color: textColor }}
                    >
                      {item.label}
                    </a>
                  )}
                </div>
              ))}
            </nav>

            {/* Mobile Actions */}
            <div className="border-t px-4 py-4 space-y-3" style={{ borderColor }}>
              {showAccount && (
                <a href="/account" className="flex items-center gap-3 py-2" style={{ color: textColor }}>
                  <User className="w-5 h-5" />
                  <span>Account</span>
                </a>
              )}
              {showSearch && (
                <button className="flex items-center gap-3 py-2 w-full" style={{ color: textColor }}>
                  <Search className="w-5 h-5" />
                  <span>Search</span>
                </button>
              )}
            </div>
          </div>
        </div>
      );
    }

    // Dropdown mobile menu
    return (
      <div
        className={`${breakpointClass}:hidden border-t`}
        style={{ backgroundColor, borderColor }}
      >
        <nav className="py-2">
          {menuItems.map((item, idx) => (
            <div key={idx}>
              {item.children && item.children.length > 0 ? (
                <div>
                  <button
                    className="flex items-center justify-between w-full px-4 py-3"
                    style={{ color: textColor }}
                    onClick={() => setActiveMenu(activeMenu === item.label ? null : item.label)}
                  >
                    {item.label}
                    <ChevronDown
                      className={`w-4 h-4 transition-transform ${activeMenu === item.label ? 'rotate-180' : ''}`}
                    />
                  </button>
                  {activeMenu === item.label && (
                    <div className="bg-gray-50 py-2">
                      {item.children.map((child, childIdx) => (
                        <a
                          key={childIdx}
                          href={child.href}
                          className="block px-8 py-2 text-sm"
                          style={{ color: textColor }}
                        >
                          {child.label}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <a
                  href={item.href}
                  className="block px-4 py-3"
                  style={{ color: textColor }}
                >
                  {item.label}
                </a>
              )}
            </div>
          ))}
        </nav>
      </div>
    );
  };

  const renderSearch = () => {
    if (!showSearch) return null;

    if (searchStyle === 'bar' || searchOpen) {
      return (
        <div className={`${searchOpen ? 'absolute inset-x-0 top-full p-4 shadow-md' : 'relative'}`} style={{ backgroundColor }}>
          <div className="relative">
            <input
              type="text"
              placeholder="Search products..."
              className="w-full pl-10 pr-4 py-2 border rounded-full focus:outline-none focus:ring-2 focus:ring-black/20"
              style={{ borderColor }}
            />
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
            {searchOpen && (
              <button
                className="absolute right-3 top-1/2 -translate-y-1/2"
                onClick={() => setSearchOpen(false)}
              >
                <X className="w-5 h-5 text-gray-400" />
              </button>
            )}
          </div>
        </div>
      );
    }

    return (
      <button
        className="p-2 hover:opacity-70 transition-opacity"
        onClick={() => setSearchOpen(true)}
        aria-label="Search"
      >
        <Search className="w-5 h-5" style={{ color: currentTextColor }} />
      </button>
    );
  };

  const navClasses = `w-full transition-all duration-300 ${
    isSticky ? 'sticky top-0 z-40' : ''
  } ${
    stickyMode === 'onScrollUp' && !isVisible ? '-translate-y-full' : 'translate-y-0'
  }`;

  return (
    <header
      ref={menuRef}
      className={navClasses}
      style={{
        backgroundColor: currentBgColor,
        borderBottom: showBorder ? `1px solid ${borderColor}` : 'none'
      }}
    >
      <div
        className="max-w-7xl mx-auto"
        style={{ paddingLeft: `${paddingX}px`, paddingRight: `${paddingX}px` }}
      >
        <div
          className="flex items-center justify-between"
          style={{ paddingTop: `${paddingY}px`, paddingBottom: `${paddingY}px` }}
        >
          {/* Logo - Left */}
          {logoPosition === 'left' && (
            <a href="/" className="flex items-center gap-2 flex-shrink-0">
              {displayLogo && (
                <img
                  src={displayLogo}
                  alt={displayLogoText}
                  style={{
                    height: `${currentLogoHeight}px`,
                    width: 'auto',
                    transition: 'height 0.3s ease'
                  }}
                  className="object-contain"
                />
              )}
              <span
                className="font-bold text-xl"
                style={{ color: currentTextColor }}
              >
                {displayLogoText}
              </span>
            </a>
          )}

          {/* Desktop Navigation - Center for left logo position */}
          {logoPosition === 'left' && renderDesktopNav()}

          {/* Logo - Center */}
          {logoPosition === 'center' && (
            <>
              {/* Left Nav */}
              <div className={`hidden ${breakpointClass}:flex items-center gap-6`}>
                {menuItems.slice(0, Math.ceil(menuItems.length / 2)).map((item, idx) => (
                  <div key={idx} className="relative group">
                    {item.children && item.children.length > 0 ? (
                      <>
                        <button
                          className="flex items-center gap-1 py-2 font-medium transition-colors"
                          style={{ color: currentTextColor }}
                        >
                          {item.label}
                          <ChevronDown className="w-4 h-4 transition-transform group-hover:rotate-180" />
                        </button>
                        {menuType === 'megamenu' ? renderMegamenu(item) : null}
                      </>
                    ) : (
                      <a href={item.href} className="py-2 font-medium" style={{ color: currentTextColor }}>
                        {item.label}
                      </a>
                    )}
                  </div>
                ))}
              </div>

              {/* Center Logo */}
              <a href="/" className="flex items-center gap-2 flex-shrink-0">
                {displayLogo && (
                  <img
                    src={displayLogo}
                    alt={displayLogoText}
                    style={{
                      height: `${currentLogoHeight}px`,
                      width: 'auto',
                      transition: 'height 0.3s ease'
                    }}
                    className="object-contain"
                  />
                )}
                <span className="font-bold text-xl" style={{ color: currentTextColor }}>
                  {displayLogoText}
                </span>
              </a>

              {/* Right Nav */}
              <div className={`hidden ${breakpointClass}:flex items-center gap-6`}>
                {menuItems.slice(Math.ceil(menuItems.length / 2)).map((item, idx) => (
                  <div key={idx} className="relative group">
                    {item.children && item.children.length > 0 ? (
                      <>
                        <button
                          className="flex items-center gap-1 py-2 font-medium transition-colors"
                          style={{ color: currentTextColor }}
                        >
                          {item.label}
                          <ChevronDown className="w-4 h-4 transition-transform group-hover:rotate-180" />
                        </button>
                        {menuType === 'megamenu' ? renderMegamenu(item) : null}
                      </>
                    ) : (
                      <a href={item.href} className="py-2 font-medium" style={{ color: currentTextColor }}>
                        {item.label}
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2">
            {/* Search */}
            {searchStyle === 'icon' && renderSearch()}

            {/* Account */}
            {showAccount && (
              <a
                href="/account"
                className={`hidden ${breakpointClass}:block p-2 hover:opacity-70 transition-opacity`}
                aria-label="Account"
              >
                <User className="w-5 h-5" style={{ color: currentTextColor }} />
              </a>
            )}

            {/* Cart */}
            {showCart && (
              <a
                href="/cart"
                className="p-2 hover:opacity-70 transition-opacity relative"
                aria-label="Cart"
              >
                <ShoppingCart className="w-5 h-5" style={{ color: currentTextColor }} />
                <span className="absolute -top-0.5 -right-0.5 bg-black text-white text-[10px] font-medium rounded-full w-4 h-4 flex items-center justify-center">
                  0
                </span>
              </a>
            )}

            {/* Mobile Menu Button */}
            <button
              className={`${breakpointClass}:hidden p-2 hover:opacity-70 transition-opacity`}
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label="Menu"
            >
              {mobileMenuOpen ? (
                <X className="w-6 h-6" style={{ color: currentTextColor }} />
              ) : (
                <Menu className="w-6 h-6" style={{ color: currentTextColor }} />
              )}
            </button>
          </div>
        </div>

        {/* Search Bar (if bar style) */}
        {searchStyle === 'bar' && showSearch && (
          <div className="pb-4">
            {renderSearch()}
          </div>
        )}
      </div>

      {/* Mobile Navigation */}
      {renderMobileNav()}
    </header>
  );
}
