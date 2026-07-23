"use client";

import React from 'react';

export interface AccountIconBlockProps {
  iconColor?: string;
  size?: 'sm' | 'md' | 'lg';
  href?: string;
  isLoggedIn?: boolean;
  showLabel?: boolean;
  labelText?: string;
  mode?: 'live' | 'preview';
}

export function AccountIconBlock({
  iconColor = '#000000',
  size = 'md',
  href = '/account',
  isLoggedIn = false,
  showLabel = false,
  labelText,
  mode = 'live'
}: AccountIconBlockProps) {
  const sizeMap = {
    sm: 20,
    md: 24,
    lg: 28,
  };

  const iconSize = sizeMap[size];
  const displayLabel = labelText || (isLoggedIn ? 'Account' : 'Login');

  return (
    <a
      href={href}
      className="inline-flex items-center gap-2 p-2 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer"
      aria-label={displayLabel}
    >
      <svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 24 24"
        fill="none"
        stroke={iconColor}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>

      {showLabel && (
        <span
          className="text-sm font-medium hidden sm:inline"
          style={{ color: iconColor }}
        >
          {displayLabel}
        </span>
      )}
    </a>
  );
}
