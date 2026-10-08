"use client";

import React, { useState, useEffect } from 'react';
import { Facebook, Twitter, Instagram, Youtube, Linkedin, Mail, Globe, ChevronDown } from 'lucide-react';

type HorizontalPosition = 'left' | 'center' | 'right';

/** A link inside a footer column. */
interface FooterLink {
  label?: string;
  url?: string;
}

/** One column of the footer's link grid. */
interface FooterColumn {
  id?: string;
  title?: string;
  links?: FooterLink[];
}

interface CurrencyOption {
  code: string;
  symbol?: string;
  name?: string;
}

interface LanguageOption {
  code: string;
  name?: string;
}

interface SocialMediaLink {
  platform: string;
  url?: string;
  enabled?: boolean;
}

/** Settings a nested footer block may carry, keyed by the block's own type. */
interface FooterBlockSettings {
  columns?: FooterColumn[];
  showCurrencySelector?: boolean;
  showLanguageSelector?: boolean;
  availableCurrencies?: CurrencyOption[];
  availableLanguages?: LanguageOption[];
  socialMediaLinks?: SocialMediaLink[];
  socialIconsPosition?: HorizontalPosition;
  copyright?: string;
  copyrightPosition?: HorizontalPosition;
  showPaymentIcons?: boolean;
}

/** A nested block rendered inside the footer. */
interface FooterBlockNode {
  id: string;
  type: string;
  settings: FooterBlockSettings;
}

export interface FooterBlockProps {
  background?: string;
  textColor?: string;
  paddingTop?: number;
  paddingBottom?: number;
  blocks?: FooterBlockNode[];
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
  socialIconsPosition?: HorizontalPosition;
  copyright?: string;
  copyrightPosition?: HorizontalPosition;
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

const POSITION_JUSTIFY: Record<string, string> = {
  left: 'justify-start',
  right: 'justify-end',
  center: 'justify-center',
};

const POSITION_TEXT_ALIGN: Record<string, string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};

const BOTTOM_AREA_CLASS: Record<HorizontalPosition, (isMobileView: boolean) => string> = {
  left: (isMobileView) => (isMobileView ? '' : 'flex justify-start'),
  center: () => 'flex justify-center',
  right: () => 'flex justify-end',
};

const PAYMENT_METHODS = ['Visa', 'Mastercard', 'PayPal', 'Apple Pay'];

interface SocialLinkItem {
  platform: string;
  url?: string;
}

function getCookie(name: string): string | null | undefined {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop()?.split(';').shift();
  return null;
}

/** Returns the cookie's value when it matches one of the available options. */
function resolveSavedCode(cookieName: string, options: Array<{ code: string }>): string | null {
  const saved = getCookie(cookieName);
  if (!saved) return null;
  return options.some((option) => option.code === saved) ? saved : null;
}

interface FooterColumnsGridProps {
  columns: FooterColumn[];
  isMobileView: boolean;
  isEditing: boolean;
  textColor: string;
}

function FooterColumnsGrid({ columns, isMobileView, isEditing, textColor }: Readonly<FooterColumnsGridProps>) {
  const gridColsClass = isMobileView
    ? 'grid-cols-1'
    : `grid-cols-2 md:grid-cols-${Math.min(columns.length, 5)}`;

  return (
    <div className={`grid gap-8 mb-12 ${gridColsClass}`}>
      {columns.map((column) => (
        <div key={column.id}>
          <h3 className="font-bold text-sm uppercase tracking-wide mb-4" style={{ color: textColor }}>
            {column.title}
          </h3>
          <ul className="space-y-3">
            {(column.links ?? []).map((link, index) => (
              <li key={index}>
                <a
                  href={link.url}
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
}

interface SocialIconLinksProps {
  links: SocialLinkItem[];
  isEditing: boolean;
}

function SocialIconLinks({ links, isEditing }: Readonly<SocialIconLinksProps>) {
  return (
    <div className="flex gap-4">
      {links.map((social, index) => {
        const Icon = socialIcons[social.platform];
        if (!Icon) return null;
        return (
          <a
            key={index}
            href={social.url}
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
  );
}

interface FooterDropdownProps {
  wrapperClass: string;
  triggerLabel: string;
  leadingIcon?: React.ReactNode;
  isOpen: boolean;
  onToggle: () => void;
  options: Array<{ code: string; label: string }>;
  selectedCode: string;
  onSelect: (code: string) => void;
  isEditing: boolean;
  textColor: string;
  background: string;
}

function FooterDropdown({
  wrapperClass,
  triggerLabel,
  leadingIcon,
  isOpen,
  onToggle,
  options,
  selectedCode,
  onSelect,
  isEditing,
  textColor,
  background,
}: Readonly<FooterDropdownProps>) {
  return (
    <div className={wrapperClass}>
      <button
        onClick={() => !isEditing && onToggle()}
        className={`flex items-center gap-2 px-4 py-2 border rounded-md transition-colors hover:opacity-70 ${isEditing ? 'pointer-events-none' : ''}`}
        style={{ borderColor: `${textColor}40`, color: textColor }}
      >
        {leadingIcon}
        <span className="text-sm">{triggerLabel}</span>
        <ChevronDown className="w-4 h-4" />
      </button>
      {isOpen && !isEditing && (
        <div
          className="absolute bottom-full mb-2 left-0 min-w-[200px] rounded-md shadow-lg border overflow-hidden z-50"
          style={{ backgroundColor: background, borderColor: `${textColor}30` }}
        >
          {options.map((option) => (
            <button
              key={option.code}
              onClick={() => onSelect(option.code)}
              className="w-full text-left px-4 py-2 text-sm transition-colors hover:opacity-70"
              style={{
                color: textColor,
                backgroundColor: selectedCode === option.code ? `${textColor}20` : 'transparent',
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface FooterSelectorsProps {
  showCurrency: boolean;
  showLanguage: boolean;
  currencies: CurrencyOption[];
  languages: LanguageOption[];
  selectedCurrency: string;
  selectedLanguage: string;
  showCurrencyDropdown: boolean;
  showLanguageDropdown: boolean;
  onToggleCurrency: () => void;
  onToggleLanguage: () => void;
  onCurrencyChange: (code: string) => void;
  onLanguageChange: (code: string) => void;
  isEditing: boolean;
  isMobileView: boolean;
  textColor: string;
  background: string;
}

function FooterSelectors({
  showCurrency,
  showLanguage,
  currencies,
  languages,
  selectedCurrency,
  selectedLanguage,
  showCurrencyDropdown,
  showLanguageDropdown,
  onToggleCurrency,
  onToggleLanguage,
  onCurrencyChange,
  onLanguageChange,
  isEditing,
  isMobileView,
  textColor,
  background,
}: Readonly<FooterSelectorsProps>) {
  if (!showCurrency && !showLanguage) return null;

  return (
    <div className={`mb-8 flex gap-4 ${isMobileView ? 'flex-col' : 'flex-row'}`}>
      {showCurrency && (
        <FooterDropdown
          wrapperClass="relative currency-selector"
          triggerLabel={currencies.find((c) => c.code === selectedCurrency)?.code || 'USD'}
          leadingIcon={<Globe className="w-4 h-4" />}
          isOpen={showCurrencyDropdown}
          onToggle={onToggleCurrency}
          options={currencies.map((c) => ({ code: c.code, label: `${c.symbol} ${c.name} (${c.code})` }))}
          selectedCode={selectedCurrency}
          onSelect={onCurrencyChange}
          isEditing={isEditing}
          textColor={textColor}
          background={background}
        />
      )}
      {showLanguage && (
        <FooterDropdown
          wrapperClass="relative language-selector"
          triggerLabel={languages.find((l) => l.code === selectedLanguage)?.name || 'English'}
          isOpen={showLanguageDropdown}
          onToggle={onToggleLanguage}
          options={languages.map((l) => ({ code: l.code, label: l.name ?? '' }))}
          selectedCode={selectedLanguage}
          onSelect={onLanguageChange}
          isEditing={isEditing}
          textColor={textColor}
          background={background}
        />
      )}
    </div>
  );
}

interface PaymentMethodsProps {
  isMobileView: boolean;
  textColor: string;
}

function PaymentMethods({ isMobileView, textColor }: Readonly<PaymentMethodsProps>) {
  return (
    <div className={`mt-8 flex gap-3 ${isMobileView ? 'justify-start' : 'justify-end'}`}>
      <div className="flex gap-2 items-center flex-wrap">
        <span className="text-xs" style={{ color: `${textColor}99` }}>Payment methods:</span>
        {PAYMENT_METHODS.map((payment, index) => (
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
}

interface BottomAreaProps {
  area: HorizontalPosition;
  className: string;
  socialLinks: SocialLinkItem[];
  socialIconsPosition: HorizontalPosition;
  copyrightPosition: HorizontalPosition;
  copyright: string;
  isEditing: boolean;
  textColor: string;
}

function BottomArea({
  area,
  className,
  socialLinks,
  socialIconsPosition,
  copyrightPosition,
  copyright,
  isEditing,
  textColor,
}: Readonly<BottomAreaProps>) {
  return (
    <div className={className}>
      {socialLinks.length > 0 && socialIconsPosition === area && (
        <SocialIconLinks links={socialLinks} isEditing={isEditing} />
      )}
      {copyrightPosition === area && (
        <div className={`text-sm ${POSITION_TEXT_ALIGN[area]}`} style={{ color: `${textColor}99` }}>
          {copyright}
        </div>
      )}
    </div>
  );
}

export function FooterBlock({
  background = '#000000',
  textColor = '#ffffff',
  paddingTop = 64,
  paddingBottom = 32,
  blocks = [],
  // Legacy props
  columns = [],
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
}: Readonly<FooterBlockProps>) {
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
    if (typeof window === 'undefined') return;

    const savedCurrency = resolveSavedCode('currency', availableCurrencies);
    if (savedCurrency) setSelectedCurrency(savedCurrency);

    const savedLocale = resolveSavedCode('locale', availableLanguages);
    if (savedLocale) setSelectedLanguage(savedLocale);
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
  const handleCurrencyChange = (currencyCode: string) => {
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
  const handleLanguageChange = (languageCode: string) => {
    setSelectedLanguage(languageCode);
    setShowLanguageDropdown(false);

    // Save to cookie
    if (typeof window !== 'undefined') {
      document.cookie = `locale=${languageCode}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;

      // Trigger page reload to apply language changes
      window.location.reload();
    }
  };

  const selectorProps = {
    selectedCurrency,
    selectedLanguage,
    showCurrencyDropdown,
    showLanguageDropdown,
    onToggleCurrency: () => setShowCurrencyDropdown(!showCurrencyDropdown),
    onToggleLanguage: () => setShowLanguageDropdown(!showLanguageDropdown),
    onCurrencyChange: handleCurrencyChange,
    onLanguageChange: handleLanguageChange,
    isEditing,
    isMobileView,
    textColor,
    background,
  };

  // Render individual footer blocks
  const renderFooterBlock = (block: FooterBlockNode) => {
    const { type, settings } = block;

    switch (type) {
      case 'footerColumns':
        return (
          <FooterColumnsGrid
            key={block.id}
            columns={settings.columns || []}
            isMobileView={isMobileView}
            isEditing={isEditing}
            textColor={textColor}
          />
        );

      case 'footerCurrencyLanguage':
        return (
          <FooterSelectors
            key={block.id}
            showCurrency={settings.showCurrencySelector !== false}
            showLanguage={settings.showLanguageSelector !== false}
            currencies={settings.availableCurrencies || availableCurrencies}
            languages={settings.availableLanguages || availableLanguages}
            {...selectorProps}
          />
        );

      case 'footerDivider':
        return (
          <div
            key={block.id}
            className="border-t mb-8 mt-8"
            style={{ borderColor: `${textColor}30` }}
          />
        );

      case 'footerSocialIcons': {
        const socialLinks = (settings.socialMediaLinks || [])
          .filter((link) => link.enabled && link.url)
          .map((link) => ({ platform: link.platform, url: link.url }));
        const position = settings.socialIconsPosition || 'left';

        if (socialLinks.length === 0) return null;

        return (
          <div key={block.id} className={`mb-8 flex ${POSITION_JUSTIFY[position]}`}>
            <SocialIconLinks links={socialLinks} isEditing={isEditing} />
          </div>
        );
      }

      case 'footerCopyright': {
        const copyrightText = settings.copyright || '© 2024 Your Store. All rights reserved.';
        const copyrightPos = settings.copyrightPosition || 'center';

        return (
          <div
            key={block.id}
            className={`text-sm mb-8 ${POSITION_TEXT_ALIGN[copyrightPos]}`}
            style={{ color: `${textColor}99` }}
          >
            {copyrightText}
          </div>
        );
      }

      case 'footerPaymentMethods':
        if (!settings.showPaymentIcons) return null;
        return <PaymentMethods key={block.id} isMobileView={isMobileView} textColor={textColor} />;

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
            <FooterColumnsGrid
              columns={columns}
              isMobileView={isMobileView}
              isEditing={isEditing}
              textColor={textColor}
            />

            <FooterSelectors
              showCurrency={showCurrencySelector}
              showLanguage={showLanguageSelector}
              currencies={availableCurrencies}
              languages={availableLanguages}
              {...selectorProps}
            />

            {/* Divider */}
            <div
              className="border-t mb-8"
              style={{ borderColor: `${textColor}30` }}
            />

            {/* Bottom Section */}
            <div className={`${isMobileView ? 'space-y-6' : 'grid grid-cols-3 gap-4 items-center'}`}>
              {(['left', 'center', 'right'] as const).map((area) => (
                <BottomArea
                  key={area}
                  area={area}
                  className={BOTTOM_AREA_CLASS[area](isMobileView)}
                  socialLinks={effectiveSocialLinks}
                  socialIconsPosition={socialIconsPosition}
                  copyrightPosition={copyrightPosition}
                  copyright={copyright}
                  isEditing={isEditing}
                  textColor={textColor}
                />
              ))}
            </div>

            {/* Payment Icons (optional) */}
            {showPaymentIcons && <PaymentMethods isMobileView={isMobileView} textColor={textColor} />}
          </>
        )}
      </div>
    </footer>
  );
}
