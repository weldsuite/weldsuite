"use client";

import React from 'react';
import { NavbarMinimalSection } from '../sections/navbar-minimal-section';

export interface NavbarMinimalBlockProps {
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

export function NavbarMinimalBlock(props: NavbarMinimalBlockProps) {
  return <NavbarMinimalSection {...props} />;
}
