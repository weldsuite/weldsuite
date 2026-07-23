"use client";

import React from 'react';

export interface CartIconBlockProps {
  itemCount?: number;
  iconColor?: string;
  badgeColor?: string;
  badgeTextColor?: string;
  size?: 'sm' | 'md' | 'lg';
  onClick?: () => void;
  mode?: 'live' | 'preview';
}

export function CartIconBlock({
  itemCount = 0,
  iconColor = '#000000',
  badgeColor = '#ef4444',
  badgeTextColor = '#ffffff',
  size = 'md',
  onClick,
  mode = 'live'
}: CartIconBlockProps) {
  const sizeMap = {
    sm: { icon: 20, badge: 'text-xs px-1.5 py-0.5' },
    md: { icon: 24, badge: 'text-xs px-2 py-0.5' },
    lg: { icon: 28, badge: 'text-sm px-2 py-1' },
  };

  const iconSize = sizeMap[size].icon;
  const badgeClasses = sizeMap[size].badge;

  const handleClick = () => {
    if (onClick) {
      onClick();
    }
  };

  return (
    <button
      onClick={handleClick}
      className="relative inline-flex items-center justify-center p-2 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer"
      aria-label={`Shopping cart with ${itemCount} items`}
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
        <circle cx="9" cy="21" r="1" />
        <circle cx="20" cy="21" r="1" />
        <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
      </svg>

      {itemCount > 0 && (
        <span
          className={`absolute -top-1 -right-1 rounded-full font-semibold ${badgeClasses} min-w-[1.25rem] flex items-center justify-center`}
          style={{
            backgroundColor: badgeColor,
            color: badgeTextColor,
          }}
        >
          {itemCount > 99 ? '99+' : itemCount}
        </span>
      )}
    </button>
  );
}
