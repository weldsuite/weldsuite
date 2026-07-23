"use client";

import React from 'react';
import { NavbarLuxurySection } from '../sections/navbar-luxury-section';

export interface NavbarLuxuryBlockProps {
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
  menuItems?: Array<{
    label: string;
    href: string;
    isActive?: boolean;
  }>;
  activeMenuStyle?: 'underline' | 'bold' | 'none';

  // Icons
  showSearch?: boolean;
  showCart?: boolean;
  showAccount?: boolean;
  iconSize?: number;

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

export function NavbarLuxuryBlock(props: NavbarLuxuryBlockProps) {
  return <NavbarLuxurySection {...props} />;
}
