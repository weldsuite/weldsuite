"use client";

import React from 'react';

interface ButtonBlockProps {
  text?: string;
  href?: string;
  url?: string;
  variant?: 'primary' | 'secondary' | 'outline';
  size?: 'sm' | 'md' | 'lg';
  backgroundColor?: string;
  textColor?: string;
  borderRadius?: number;
  alignment?: 'left' | 'center' | 'right';
  mode?: string;
}

export function ButtonBlock({
  text = 'Button',
  href,
  url,
  variant = 'primary',
  size = 'md',
  backgroundColor,
  textColor,
  borderRadius = 2,
  alignment = 'left',
  mode = 'live'
}: ButtonBlockProps) {
  // Support both 'url' and 'href' props, with 'url' taking precedence
  const linkUrl = url || href || '#';

  // Shopify-style button sizing with better touch targets
  const sizeClasses = {
    sm: 'px-4 py-2 text-sm font-medium',
    md: 'px-6 py-3 text-base font-medium',
    lg: 'px-8 py-4 text-lg font-medium',
  }[size];

  const variantStyles = {
    primary: {
      backgroundColor: backgroundColor || '#000000',
      color: textColor || '#ffffff',
      border: 'none',
    },
    secondary: {
      backgroundColor: backgroundColor || '#f3f4f6',
      color: textColor || '#111827',
      border: 'none',
    },
    outline: {
      backgroundColor: 'transparent',
      color: textColor || '#000000',
      border: `1.5px solid ${backgroundColor || '#000000'}`,
    },
  }[variant];

  const baseClasses = 'inline-flex items-center justify-center transition-all duration-200 ease-in-out cursor-pointer select-none';
  const hoverClasses = variant === 'outline'
    ? 'hover:bg-black/5 active:bg-black/10'
    : 'hover:opacity-90 active:opacity-80 hover:shadow-lg';

  const alignmentClass = {
    left: 'text-left',
    center: 'text-center',
    right: 'text-right',
  }[alignment];

  return (
    <div className={`w-full ${alignmentClass}`}>
      <a
        href={linkUrl}
        className={`${baseClasses} ${hoverClasses} ${sizeClasses}`}
        style={{
          ...variantStyles,
          borderRadius: `${borderRadius}px`,
          textDecoration: 'none',
          letterSpacing: '0.01em',
        }}
      >
        {text}
      </a>
    </div>
  );
}
