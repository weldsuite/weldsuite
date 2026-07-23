"use client";

import React from 'react';
import { Search, ShoppingBag, User, Menu, X } from 'lucide-react';

interface NavbarMinimalSectionProps {
  logo?: string;
  logoText?: string;
  logoPosition?: 'left' | 'center' | 'right';
  logoStyle?: 'text' | 'image';
  logoFontSize?: number;
  logoFontWeight?: string;
  logoLetterSpacing?: number;
  showSearch?: boolean;
  searchPosition?: 'left' | 'right';
  showCart?: boolean;
  showAccount?: boolean;
  actionsPosition?: 'left' | 'right';
  backgroundColor?: string;
  textColor?: string;
  iconColor?: string;
  iconSize?: number;
  paddingY?: number;
  paddingX?: number;
  stickyHeader?: boolean;
  showBorder?: boolean;
  borderColor?: string;
  minimalStyle?: boolean;
  store?: any;
  mode?: string;
}

export function NavbarMinimalSection({
  logo,
  logoText = 'YOUR BRAND',
  logoPosition = 'center',
  logoStyle = 'text',
  logoFontSize = 18,
  logoFontWeight = '500',
  logoLetterSpacing = 4,
  showSearch = true,
  searchPosition = 'left',
  showCart = true,
  showAccount = true,
  actionsPosition = 'right',
  backgroundColor = '#1a1f1a',
  textColor = '#ffffff',
  iconColor = '#ffffff',
  iconSize = 20,
  paddingY = 16,
  paddingX = 40,
  stickyHeader = true,
  showBorder = false,
  borderColor = '#333333',
  minimalStyle = true,
  store,
  mode = 'live'
}: NavbarMinimalSectionProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = React.useState(false);
  const [searchOpen, setSearchOpen] = React.useState(false);

  const displayLogo = logo || store?.logo;
  const displayLogoText = logoText || store?.name || 'YOUR BRAND';

  const renderSearch = () => {
    if (!showSearch) return null;

    if (searchOpen) {
      return (
        <div className="absolute inset-0 flex items-center px-4 z-50" style={{ backgroundColor }}>
          <div className="flex-1 relative">
            <input
              type="text"
              placeholder="Search..."
              autoFocus
              className="w-full bg-transparent border-b py-2 pr-8 focus:outline-none"
              style={{
                color: textColor,
                borderColor: `${textColor}33`
              }}
            />
            <button
              className="absolute right-0 top-1/2 -translate-y-1/2 p-1"
              onClick={() => setSearchOpen(false)}
            >
              <X style={{ width: iconSize, height: iconSize, color: iconColor }} />
            </button>
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
        <Search style={{ width: iconSize, height: iconSize, color: iconColor }} />
      </button>
    );
  };

  const renderLogo = () => {
    if (logoStyle === 'image' && displayLogo) {
      return (
        <a href="/" className="flex items-center justify-center">
          <img
            src={displayLogo}
            alt={displayLogoText}
            className="h-8 w-auto object-contain"
          />
        </a>
      );
    }

    return (
      <a
        href="/"
        className="tracking-widest uppercase"
        style={{
          color: textColor,
          fontSize: `${logoFontSize}px`,
          fontWeight: logoFontWeight,
          letterSpacing: `${logoLetterSpacing}px`
        }}
      >
        {displayLogoText}
      </a>
    );
  };

  const renderActions = () => (
    <div className="flex items-center gap-4">
      {showAccount && (
        <a
          href="/account"
          className="p-1 hover:opacity-70 transition-opacity"
          aria-label="Account"
        >
          <User style={{ width: iconSize, height: iconSize, color: iconColor }} />
        </a>
      )}
      {showCart && (
        <a
          href="/cart"
          className="p-1 hover:opacity-70 transition-opacity relative"
          aria-label="Cart"
        >
          <ShoppingBag style={{ width: iconSize, height: iconSize, color: iconColor }} />
        </a>
      )}
    </div>
  );

  return (
    <header
      className={`w-full ${stickyHeader ? 'sticky top-0 z-40' : ''}`}
      style={{
        backgroundColor,
        borderBottom: showBorder ? `1px solid ${borderColor}` : 'none'
      }}
    >
      <div
        className="relative"
        style={{
          paddingTop: `${paddingY}px`,
          paddingBottom: `${paddingY}px`,
          paddingLeft: `${paddingX}px`,
          paddingRight: `${paddingX}px`
        }}
      >
        {/* Desktop Layout */}
        <div className="hidden md:grid grid-cols-3 items-center">
          {/* Left Side */}
          <div className="flex items-center justify-start">
            {searchPosition === 'left' && renderSearch()}
            {actionsPosition === 'left' && renderActions()}
          </div>

          {/* Center - Logo */}
          <div className="flex items-center justify-center">
            {renderLogo()}
          </div>

          {/* Right Side */}
          <div className="flex items-center justify-end gap-4">
            {searchPosition === 'right' && renderSearch()}
            {actionsPosition === 'right' && renderActions()}
          </div>
        </div>

        {/* Mobile Layout */}
        <div className="md:hidden flex items-center justify-between">
          {/* Left - Search */}
          <div className="flex items-center">
            {renderSearch()}
          </div>

          {/* Center - Logo */}
          <div className="absolute left-1/2 -translate-x-1/2">
            {renderLogo()}
          </div>

          {/* Right - Actions */}
          <div className="flex items-center gap-2">
            {renderActions()}
          </div>
        </div>
      </div>
    </header>
  );
}
