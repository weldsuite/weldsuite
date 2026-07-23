"use client";

import React from 'react';
import { NavbarShopifySection } from '../sections/navbar-shopify-section';

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

export interface NavbarShopifyBlockProps {
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

export function NavbarShopifyBlock(props: NavbarShopifyBlockProps) {
  return <NavbarShopifySection {...props} />;
}
