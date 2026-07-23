"use client";

import React, { useState } from 'react';
import { DynamicIcon } from 'lucide-react/dynamic';
import {
  X,
  Facebook,
  Instagram,
  Twitter,
  Youtube,
  Linkedin,
  Star,
} from 'lucide-react';

function toKebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

// TikTok icon (not available in lucide-react)
const TikTokIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z"/>
  </svg>
);

// Pinterest icon (not available in lucide-react)
const PinterestIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 0a12 12 0 0 0-4.37 23.17c-.1-.94-.2-2.4.04-3.44l1.4-5.96s-.36-.72-.36-1.78c0-1.67.97-2.92 2.17-2.92 1.02 0 1.52.77 1.52 1.7 0 1.03-.66 2.58-1 4.01-.28 1.2.6 2.17 1.78 2.17 2.14 0 3.78-2.26 3.78-5.52 0-2.89-2.08-4.91-5.04-4.91-3.43 0-5.45 2.58-5.45 5.24 0 1.04.4 2.15.9 2.76a.36.36 0 0 1 .08.34l-.33 1.36c-.05.22-.18.27-.4.16-1.5-.7-2.43-2.89-2.43-4.65 0-3.78 2.75-7.26 7.93-7.26 4.16 0 7.4 2.97 7.4 6.93 0 4.14-2.6 7.46-6.22 7.46-1.22 0-2.36-.63-2.75-1.38l-.75 2.85c-.27 1.04-1 2.35-1.49 3.15A12 12 0 1 0 12 0z"/>
  </svg>
);

interface SocialMediaLink {
  platform: string;
  url: string;
  enabled: boolean;
}

interface Feature {
  id: string;
  icon: string;
  text: string;
  enabled: boolean;
}

export interface AnnouncementBarBlockProps {
  rating?: number;
  reviewCount?: number;
  features?: {
    freeShipping?: { enabled: boolean; text: string };
    returns?: { enabled: boolean; text: string };
    warranty?: { enabled: boolean; text: string };
    support?: { enabled: boolean; text: string };
  };
  featuresList?: Feature[];
  showRating?: boolean;
  showVerifiedBadge?: boolean;
  verifiedBadgeText?: string;
  showSocialIcons?: boolean;
  socialMediaLinks?: SocialMediaLink[];
  socialIconsColor?: string;
  socialIconsPosition?: 'left' | 'right';
  backgroundColor?: string;
  textColor?: string;
  iconColor?: string;
  dismissible?: boolean;
  mode?: 'live' | 'preview' | 'edit';
}

export function AnnouncementBarBlock({
  rating = 4.8,
  reviewCount = 25000,
  features = {
    freeShipping: { enabled: true, text: 'Free shipping over $75' },
    returns: { enabled: true, text: '30-day free returns' },
    warranty: { enabled: true, text: '2-year warranty' },
    support: { enabled: true, text: '24/7 support' },
  },
  featuresList,
  showRating = true,
  showVerifiedBadge = false,
  verifiedBadgeText = 'Verified Seller',
  showSocialIcons = false,
  socialMediaLinks = [],
  socialIconsColor,
  socialIconsPosition = 'left',
  backgroundColor = '#f3f4f6',
  textColor = '#6b7280',
  iconColor,
  dismissible = true,
  mode = 'live'
}: AnnouncementBarBlockProps) {
  const [isVisible, setIsVisible] = useState(true);

  // Icon mapping function - dynamically resolve any Lucide icon
  const getFeatureIcon = (iconName: string) => {
    const iconClass = 'size-4';
    if (!iconName) return <Star className={iconClass} />;
    const kebab = (iconName.includes('-') ? iconName : toKebab(iconName)).toLowerCase();
    return (
      <DynamicIcon
        name={kebab as never}
        className={iconClass}
        fallback={() => <Star className={iconClass} />}
      />
    );
  };

  // Use featuresList if available, otherwise fall back to legacy features object
  const featureItems = featuresList
    ? featuresList.filter(f => f.enabled !== false).map(f => ({
        icon: getFeatureIcon(f.icon),
        text: f.text,
        enabled: f.enabled !== false,
      }))
    : [
        { icon: getFeatureIcon('Truck'), text: features?.freeShipping?.text || 'Free shipping over $75', enabled: features?.freeShipping?.enabled ?? true },
        { icon: getFeatureIcon('RotateCcw'), text: features?.returns?.text || '30-day free returns', enabled: features?.returns?.enabled ?? true },
        { icon: getFeatureIcon('Shield'), text: features?.warranty?.text || '2-year warranty', enabled: features?.warranty?.enabled ?? true },
        { icon: getFeatureIcon('Headphones'), text: features?.support?.text || '24/7 support', enabled: features?.support?.enabled ?? true },
      ].filter(f => f.enabled);

  // Get enabled social media links
  const enabledSocialLinks = socialMediaLinks?.filter(link => link.enabled) || [];

  // Social icon mapping
  const getSocialIcon = (platform: string) => {
    const iconClass = "size-4";
    switch (platform) {
      case 'facebook':
        return <Facebook className={iconClass} />;
      case 'instagram':
        return <Instagram className={iconClass} />;
      case 'twitter':
        return <Twitter className={iconClass} />;
      case 'youtube':
        return <Youtube className={iconClass} />;
      case 'linkedin':
        return <Linkedin className={iconClass} />;
      case 'tiktok':
        return <TikTokIcon className={iconClass} />;
      case 'pinterest':
        return <PinterestIcon className={iconClass} />;
      default:
        return null;
    }
  };

  if (!isVisible && mode === 'live') return null;

  const isEditing = mode === 'edit' || mode === 'preview';

  // Use iconColor if provided, otherwise fall back to textColor
  const effectiveIconColor = iconColor || textColor;
  const effectiveSocialIconsColor = socialIconsColor || textColor;

  return (
    <section
      className="py-4 relative"
      style={{ backgroundColor }}
    >
      <div className="max-w-7xl mx-auto px-4">
        <div className="flex items-center justify-between gap-4">
          {/* Social Icons - Left */}
          {showSocialIcons && enabledSocialLinks.length > 0 && socialIconsPosition === 'left' && (
            <div className="flex items-center gap-3">
              {enabledSocialLinks.map((link) => (
                <a
                  key={link.platform}
                  href={link.url || '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:opacity-70 transition-opacity"
                  style={{ color: effectiveSocialIconsColor }}
                  onClick={(e) => {
                    if (isEditing) {
                      e.preventDefault();
                      e.stopPropagation();
                    }
                  }}
                >
                  {getSocialIcon(link.platform)}
                </a>
              ))}
            </div>
          )}

          {/* Spacer for when social icons are not on the left */}
          {(!showSocialIcons || enabledSocialLinks.length === 0 || socialIconsPosition !== 'left') && (
            <div className="w-10" />
          )}

          {/* Features - Center */}
          <div className="flex flex-wrap items-center justify-center gap-4 md:gap-6 flex-1">
            {featureItems.map((feature, index) => (
              <div
                key={index}
                className="flex items-center gap-1.5 text-sm"
                style={{ color: textColor }}
              >
                <span style={{ color: effectiveIconColor }}>{feature.icon}</span>
                <span>{feature.text}</span>
              </div>
            ))}
          </div>

          {/* Social Icons - Right (before close button) */}
          {showSocialIcons && enabledSocialLinks.length > 0 && socialIconsPosition === 'right' && (
            <div className="flex items-center gap-3 mr-8">
              {enabledSocialLinks.map((link) => (
                <a
                  key={link.platform}
                  href={link.url || '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:opacity-70 transition-opacity"
                  style={{ color: effectiveSocialIconsColor }}
                  onClick={(e) => {
                    if (isEditing) {
                      e.preventDefault();
                      e.stopPropagation();
                    }
                  }}
                >
                  {getSocialIcon(link.platform)}
                </a>
              ))}
            </div>
          )}

          {/* Spacer for close button */}
          {(!showSocialIcons || enabledSocialLinks.length === 0 || socialIconsPosition !== 'right') && (
            <div className="w-10" />
          )}
        </div>
      </div>
      {/* Close button */}
      {dismissible && (
        <button
          onClick={(e) => {
            if (isEditing) {
              e.preventDefault();
              e.stopPropagation();
            } else {
              setIsVisible(false);
            }
          }}
          className={`absolute right-4 top-1/2 -translate-y-1/2 p-1 rounded transition-colors ${isEditing ? 'pointer-events-none' : ''}`}
          style={{ color: textColor }}
          aria-label="Dismiss announcement"
        >
          <X className="size-4" />
        </button>
      )}
    </section>
  );
}
