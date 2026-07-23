"use client";

import React, { useState, useEffect } from 'react';
import { Facebook, Twitter, Instagram, Youtube, Linkedin, Mail, Globe, ChevronDown } from 'lucide-react';

export interface FooterBlockProps {
  background?: string;
  textColor?: string;
  paddingTop?: number;
  paddingBottom?: number;
  blocks?: Array<{
    id: string;
    type: string;
    settings: any;
  }>;
  // Legacy props for backwards compatibility
  columns?: Array<{
    id: string;
    title: string;
    links: Array<{ label: string; url: string }>;
  }>;
  socialLinks?: Array<{
    platform: string;
    url: string;
  }>;
  showSocialIcons?: boolean;
  socialMediaLinks?: Array<{
    platform: string;
    url: string;
    enabled: boolean;
  }>;
  socialIconsPosition?: 'left' | 'center' | 'right';
  copyright?: string;
  copyrightPosition?: 'left' | 'center' | 'right';
  showPaymentIcons?: boolean;
  showCurrencySelector?: boolean;
  showLanguageSelector?: boolean;
  availableCurrencies?: Array<{
    code: string;
    symbol: string;
    name: string;
  }>;
  availableLanguages?: Array<{
    code: string;
    name: string;
  }>;
  mode?: 'live' | 'edit' | 'preview';
  previewMode?: 'desktop' | 'tablet' | 'mobile';
}

const socialIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  facebook: Facebook,
  twitter: Twitter,
  instagram: Instagram,
  youtube: Youtube,
  linkedin: Linkedin,
  mail: Mail,
};

export function FooterBlock({
  background = '#000000',
  textColor = '#ffffff',
  paddingTop = 64,
  paddingBottom = 32,
  blocks = [],
  // Legacy props
  columns = [],
  socialLinks = [],
  showSocialIcons = false,
  socialMediaLinks = [],
  socialIconsPosition = 'left',
  copyright = '© 2024 Your Store. All rights reserved.',
  copyrightPosition = 'left',
  showPaymentIcons = true,
  showCurrencySelector = true,
  showLanguageSelector = true,
  availableCurrencies = [
    { code: 'USD', symbol: '$', name: 'US Dollar' },
    { code: 'EUR', symbol: '€', name: 'Euro' },
    { code: 'GBP', symbol: '£', name: 'British Pound' },
    { code: 'CAD', symbol: 'C$', name: 'Canadian Dollar' },
    { code: 'AUD', symbol: 'A$', name: 'Australian Dollar' },
  ],
  availableLanguages = [
    { code: 'en', name: 'English' },
    { code: 'nl', name: 'Nederlands' },
    { code: 'fr', name: 'Français' },
    { code: 'de', name: 'Deutsch' },
    { code: 'es', name: 'Español' },
  ],
  mode = 'live',
  previewMode = 'desktop',
}: FooterBlockProps) {
  const isEditing = mode === 'edit' || mode === 'preview';
  const isMobileView = previewMode === 'mobile';

  // Use blocks-based rendering if blocks are provided
  const useBlocksRendering = blocks && blocks.length > 0;

  // Only show social icons when the section is explicitly enabled
  // Don't show by default, only when showSocialIcons is true
  const effectiveSocialLinks = showSocialIcons
    ? socialMediaLinks.filter(link => link.enabled && link.url).map(link => ({
        platform: link.platform,
        url: link.url
      }))
    : [];

  const [selectedCurrency, setSelectedCurrency] = useState(availableCurrencies[0]?.code || 'USD');
  const [selectedLanguage, setSelectedLanguage] = useState(availableLanguages[0]?.code || 'en');
  const [showCurrencyDropdown, setShowCurrencyDropdown] = useState(false);
  const [showLanguageDropdown, setShowLanguageDropdown] = useState(false);

  // Load saved preferences from cookies on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const getCookie = (name: string) => {
        const value = `; ${document.cookie}`;
        const parts = value.split(`; ${name}=`);
        if (parts.length === 2) return parts.pop()?.split(';').shift();
        return null;
      };

      const savedCurrency = getCookie('currency');
      const savedLocale = getCookie('locale');

      if (savedCurrency && availableCurrencies.find(c => c.code === savedCurrency)) {
        setSelectedCurrency(savedCurrency);
      }

      if (savedLocale && availableLanguages.find(l => l.code === savedLocale)) {
        setSelectedLanguage(savedLocale);
      }
    }
  }, [availableCurrencies, availableLanguages]);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.currency-selector') && !target.closest('.language-selector')) {
        setShowCurrencyDropdown(false);
        setShowLanguageDropdown(false);
      }
    };

    if (showCurrencyDropdown || showLanguageDropdown) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [showCurrencyDropdown, showLanguageDropdown]);

  // Handle currency change
  const handleCurrencyChange = async (currencyCode: string) => {
    setSelectedCurrency(currencyCode);
    setShowCurrencyDropdown(false);

    // Save to cookie
    if (typeof window !== 'undefined') {
      document.cookie = `currency=${currencyCode}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;

      // Trigger page reload to apply currency changes
      window.location.reload();
    }
  };

  // Handle language change
  const handleLanguageChange = async (languageCode: string) => {
    setSelectedLanguage(languageCode);
    setShowLanguageDropdown(false);

    // Save to cookie
    if (typeof window !== 'undefined') {
      document.cookie = `locale=${languageCode}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;

      // Trigger page reload to apply language changes
      window.location.reload();
    }
  };

  // Render individual footer blocks
  const renderFooterBlock = (block: any) => {
    const { type, settings } = block;

    switch (type) {
      case 'footerColumns':
        const columnCount = (settings.columns || []).length;
        const gridColsClass = isMobileView
          ? 'grid-cols-1'
          : `grid-cols-2 md:grid-cols-${Math.min(columnCount, 5)}`;

        return (
          <div key={block.id} className={`grid gap-8 mb-12 ${gridColsClass}`}>
            {(settings.columns || []).map((column: any) => (
              <div key={column.id}>
                <h3 className="font-bold text-sm uppercase tracking-wide mb-4" style={{ color: textColor }}>
                  {column.title}
                </h3>
                <ul className="space-y-3">
                  {column.links.map((link: any, index: number) => (
                    <li key={index}>
                      <a
                        href={isEditing ? undefined : link.url}
                        onClick={(e) => isEditing && e.preventDefault()}
                        className={`text-sm hover:opacity-70 transition-opacity ${isEditing ? 'pointer-events-none' : ''}`}
                        style={{ color: `${textColor}cc` }}
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        );

      case 'footerCurrencyLanguage':
        const showCurrency = settings.showCurrencySelector !== false;
        const showLanguage = settings.showLanguageSelector !== false;
        const currencies = settings.availableCurrencies || availableCurrencies;
        const languages = settings.availableLanguages || availableLanguages;

        if (!showCurrency && !showLanguage) return null;

        return (
          <div key={block.id} className={`mb-8 flex gap-4 ${isMobileView ? 'flex-col' : 'flex-row'}`}>
            {showCurrency && (
              <div className="relative currency-selector">
                <button
                  onClick={() => !isEditing && setShowCurrencyDropdown(!showCurrencyDropdown)}
                  className={`flex items-center gap-2 px-4 py-2 border rounded-md transition-colors hover:opacity-70 ${isEditing ? 'pointer-events-none' : ''}`}
                  style={{ borderColor: `${textColor}40`, color: textColor }}
                >
                  <Globe className="w-4 h-4" />
                  <span className="text-sm">{currencies.find((c: any) => c.code === selectedCurrency)?.code || 'USD'}</span>
                  <ChevronDown className="w-4 h-4" />
                </button>
                {showCurrencyDropdown && !isEditing && (
                  <div
                    className="absolute bottom-full mb-2 left-0 min-w-[200px] rounded-md shadow-lg border overflow-hidden z-50"
                    style={{ backgroundColor: background, borderColor: `${textColor}30` }}
                  >
                    {currencies.map((currency: any) => (
                      <button
                        key={currency.code}
                        onClick={() => handleCurrencyChange(currency.code)}
                        className="w-full text-left px-4 py-2 text-sm transition-colors hover:opacity-70"
                        style={{
                          color: textColor,
                          backgroundColor: selectedCurrency === currency.code ? `${textColor}20` : 'transparent'
                        }}
                      >
                        {currency.symbol} {currency.name} ({currency.code})
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {showLanguage && (
              <div className="relative language-selector">
                <button
                  onClick={() => !isEditing && setShowLanguageDropdown(!showLanguageDropdown)}
                  className={`flex items-center gap-2 px-4 py-2 border rounded-md transition-colors hover:opacity-70 ${isEditing ? 'pointer-events-none' : ''}`}
                  style={{ borderColor: `${textColor}40`, color: textColor }}
                >
                  <span className="text-sm">{languages.find((l: any) => l.code === selectedLanguage)?.name || 'English'}</span>
                  <ChevronDown className="w-4 h-4" />
                </button>
                {showLanguageDropdown && !isEditing && (
                  <div
                    className="absolute bottom-full mb-2 left-0 min-w-[200px] rounded-md shadow-lg border overflow-hidden z-50"
                    style={{ backgroundColor: background, borderColor: `${textColor}30` }}
                  >
                    {languages.map((language: any) => (
                      <button
                        key={language.code}
                        onClick={() => handleLanguageChange(language.code)}
                        className="w-full text-left px-4 py-2 text-sm transition-colors hover:opacity-70"
                        style={{
                          color: textColor,
                          backgroundColor: selectedLanguage === language.code ? `${textColor}20` : 'transparent'
                        }}
                      >
                        {language.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );

      case 'footerDivider':
        return (
          <div
            key={block.id}
            className="border-t mb-8 mt-8"
            style={{ borderColor: `${textColor}30` }}
          />
        );

      case 'footerSocialIcons':
        const socialLinks = (settings.socialMediaLinks || [])
          .filter((link: any) => link.enabled && link.url)
          .map((link: any) => ({ platform: link.platform, url: link.url }));
        const position = settings.socialIconsPosition || 'left';

        if (socialLinks.length === 0) return null;

        return (
          <div key={block.id} className={`mb-8 flex ${position === 'left' ? 'justify-start' : position === 'right' ? 'justify-end' : 'justify-center'}`}>
            <div className="flex gap-4">
              {socialLinks.map((social: any, index: number) => {
                const Icon = socialIcons[social.platform];
                if (!Icon) return null;
                return (
                  <a
                    key={index}
                    href={isEditing ? undefined : social.url}
                    onClick={(e) => isEditing && e.preventDefault()}
                    className={`hover:opacity-70 transition-opacity ${isEditing ? 'pointer-events-none' : ''}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={social.platform}
                  >
                    <Icon className="w-5 h-5" />
                  </a>
                );
              })}
            </div>
          </div>
        );

      case 'footerCopyright':
        const copyrightText = settings.copyright || '© 2024 Your Store. All rights reserved.';
        const copyrightPos = settings.copyrightPosition || 'center';

        return (
          <div
            key={block.id}
            className={`text-sm mb-8 ${copyrightPos === 'left' ? 'text-left' : copyrightPos === 'right' ? 'text-right' : 'text-center'}`}
            style={{ color: `${textColor}99` }}
          >
            {copyrightText}
          </div>
        );

      case 'footerPaymentMethods':
        if (!settings.showPaymentIcons) return null;

        return (
          <div key={block.id} className={`mt-8 flex gap-3 ${isMobileView ? 'justify-start' : 'justify-end'}`}>
            <div className="flex gap-2 items-center flex-wrap">
              <span className="text-xs" style={{ color: `${textColor}99` }}>Payment methods:</span>
              {['Visa', 'Mastercard', 'PayPal', 'Apple Pay'].map((payment, index) => (
                <div
                  key={index}
                  className="px-2 py-1 border rounded text-xs font-medium"
                  style={{ borderColor: `${textColor}30`, color: `${textColor}99` }}
                >
                  {payment}
                </div>
              ))}
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <footer
      className="w-full"
      style={{
        backgroundColor: background,
        color: textColor,
        paddingTop: `${paddingTop}px`,
        paddingBottom: `${paddingBottom}px`,
      }}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {useBlocksRendering ? (
          // Render using blocks array
          blocks.map(renderFooterBlock)
        ) : (
          <>
        {/* Footer Columns */}
        <div className={`grid gap-8 mb-12 ${isMobileView ? 'grid-cols-1' : `grid-cols-2 md:grid-cols-${Math.min(columns.length, 5)}`}`}>
          {columns.map((column) => (
            <div key={column.id}>
              <h3
                className="font-bold text-sm uppercase tracking-wide mb-4"
                style={{ color: textColor }}
              >
                {column.title}
              </h3>
              <ul className="space-y-3">
                {column.links.map((link, index) => (
                  <li key={index}>
                    <a
                      href={isEditing ? undefined : link.url}
                      onClick={(e) => isEditing && e.preventDefault()}
                      className={`text-sm hover:opacity-70 transition-opacity ${
                        isEditing ? 'pointer-events-none' : ''
                      }`}
                      style={{ color: `${textColor}cc` }}
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Currency and Language Selectors */}
        {(showCurrencySelector || showLanguageSelector) && (
          <div className={`mb-8 flex gap-4 ${isMobileView ? 'flex-col' : 'flex-row'}`}>
            {/* Currency Selector */}
            {showCurrencySelector && (
              <div className="relative currency-selector">
                <button
                  onClick={() => !isEditing && setShowCurrencyDropdown(!showCurrencyDropdown)}
                  className={`flex items-center gap-2 px-4 py-2 border rounded-md transition-colors hover:opacity-70 ${
                    isEditing ? 'pointer-events-none' : ''
                  }`}
                  style={{
                    borderColor: `${textColor}40`,
                    color: textColor,
                  }}
                >
                  <Globe className="w-4 h-4" />
                  <span className="text-sm">
                    {availableCurrencies.find(c => c.code === selectedCurrency)?.code || 'USD'}
                  </span>
                  <ChevronDown className="w-4 h-4" />
                </button>

                {/* Currency Dropdown */}
                {showCurrencyDropdown && !isEditing && (
                  <div
                    className="absolute bottom-full mb-2 left-0 min-w-[200px] rounded-md shadow-lg border overflow-hidden z-50"
                    style={{
                      backgroundColor: background,
                      borderColor: `${textColor}30`,
                    }}
                  >
                    {availableCurrencies.map((currency) => (
                      <button
                        key={currency.code}
                        onClick={() => handleCurrencyChange(currency.code)}
                        className="w-full text-left px-4 py-2 text-sm transition-colors hover:opacity-70"
                        style={{
                          color: textColor,
                          backgroundColor: selectedCurrency === currency.code ? `${textColor}20` : 'transparent',
                        }}
                      >
                        {currency.symbol} {currency.name} ({currency.code})
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Language Selector */}
            {showLanguageSelector && (
              <div className="relative language-selector">
                <button
                  onClick={() => !isEditing && setShowLanguageDropdown(!showLanguageDropdown)}
                  className={`flex items-center gap-2 px-4 py-2 border rounded-md transition-colors hover:opacity-70 ${
                    isEditing ? 'pointer-events-none' : ''
                  }`}
                  style={{
                    borderColor: `${textColor}40`,
                    color: textColor,
                  }}
                >
                  <span className="text-sm">
                    {availableLanguages.find(l => l.code === selectedLanguage)?.name || 'English'}
                  </span>
                  <ChevronDown className="w-4 h-4" />
                </button>

                {/* Language Dropdown */}
                {showLanguageDropdown && !isEditing && (
                  <div
                    className="absolute bottom-full mb-2 left-0 min-w-[200px] rounded-md shadow-lg border overflow-hidden z-50"
                    style={{
                      backgroundColor: background,
                      borderColor: `${textColor}30`,
                    }}
                  >
                    {availableLanguages.map((language) => (
                      <button
                        key={language.code}
                        onClick={() => handleLanguageChange(language.code)}
                        className="w-full text-left px-4 py-2 text-sm transition-colors hover:opacity-70"
                        style={{
                          color: textColor,
                          backgroundColor: selectedLanguage === language.code ? `${textColor}20` : 'transparent',
                        }}
                      >
                        {language.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Divider */}
        <div
          className="border-t mb-8"
          style={{ borderColor: `${textColor}30` }}
        />

        {/* Bottom Section */}
        <div className={`${isMobileView ? 'space-y-6' : 'grid grid-cols-3 gap-4 items-center'}`}>
          {/* Left Area */}
          <div className={`${isMobileView ? '' : 'flex justify-start'}`}>
            {effectiveSocialLinks && effectiveSocialLinks.length > 0 && socialIconsPosition === 'left' && (
              <div className="flex gap-4">
                {effectiveSocialLinks.map((social, index) => {
                  const Icon = socialIcons[social.platform];
                  if (!Icon) return null;

                  return (
                    <a
                      key={index}
                      href={isEditing ? undefined : social.url}
                      onClick={(e) => isEditing && e.preventDefault()}
                      className={`hover:opacity-70 transition-opacity ${
                        isEditing ? 'pointer-events-none' : ''
                      }`}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={social.platform}
                    >
                      <Icon className="w-5 h-5" />
                    </a>
                  );
                })}
              </div>
            )}
            {copyrightPosition === 'left' && (
              <div className="text-sm text-left" style={{ color: `${textColor}99` }}>
                {copyright}
              </div>
            )}
          </div>

          {/* Center Area */}
          <div className="flex justify-center">
            {effectiveSocialLinks && effectiveSocialLinks.length > 0 && socialIconsPosition === 'center' && (
              <div className="flex gap-4">
                {effectiveSocialLinks.map((social, index) => {
                  const Icon = socialIcons[social.platform];
                  if (!Icon) return null;

                  return (
                    <a
                      key={index}
                      href={isEditing ? undefined : social.url}
                      onClick={(e) => isEditing && e.preventDefault()}
                      className={`hover:opacity-70 transition-opacity ${
                        isEditing ? 'pointer-events-none' : ''
                      }`}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={social.platform}
                    >
                      <Icon className="w-5 h-5" />
                    </a>
                  );
                })}
              </div>
            )}
            {copyrightPosition === 'center' && (
              <div className="text-sm text-center" style={{ color: `${textColor}99` }}>
                {copyright}
              </div>
            )}
          </div>

          {/* Right Area */}
          <div className="flex justify-end">
            {effectiveSocialLinks && effectiveSocialLinks.length > 0 && socialIconsPosition === 'right' && (
              <div className="flex gap-4">
                {effectiveSocialLinks.map((social, index) => {
                  const Icon = socialIcons[social.platform];
                  if (!Icon) return null;

                  return (
                    <a
                      key={index}
                      href={isEditing ? undefined : social.url}
                      onClick={(e) => isEditing && e.preventDefault()}
                      className={`hover:opacity-70 transition-opacity ${
                        isEditing ? 'pointer-events-none' : ''
                      }`}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={social.platform}
                    >
                      <Icon className="w-5 h-5" />
                    </a>
                  );
                })}
              </div>
            )}
            {copyrightPosition === 'right' && (
              <div className="text-sm text-right" style={{ color: `${textColor}99` }}>
                {copyright}
              </div>
            )}
          </div>
        </div>

        {/* Payment Icons (optional) */}
        {showPaymentIcons && (
          <div className={`mt-8 flex gap-3 ${isMobileView ? 'justify-start' : 'justify-end'}`}>
            <div className="flex gap-2 items-center flex-wrap">
              <span className="text-xs" style={{ color: `${textColor}99` }}>Payment methods:</span>
              {['Visa', 'Mastercard', 'PayPal', 'Apple Pay'].map((payment, index) => (
                <div
                  key={index}
                  className="px-2 py-1 border rounded text-xs font-medium"
                  style={{
                    borderColor: `${textColor}30`,
                    color: `${textColor}99`,
                  }}
                >
                  {payment}
                </div>
              ))}
            </div>
          </div>
        )}
          </>
        )}
      </div>
    </footer>
  );
}
