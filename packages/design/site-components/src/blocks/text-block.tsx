"use client";

import React from 'react';

interface TextBlockProps {
  content?: string;
  alignment?: 'left' | 'center' | 'right';
  fontSize?: 'sm' | 'base' | 'lg' | 'xl' | '2xl';
  fontWeight?: 'normal' | 'medium' | 'semibold' | 'bold';
  color?: string;
  mode?: string;
}

export function TextBlock({
  content = 'Add your text here',
  alignment = 'left',
  fontSize = 'base',
  fontWeight = 'normal',
  color = '#000000',
  mode = 'live'
}: TextBlockProps) {
  const alignmentClass = {
    left: 'text-left',
    center: 'text-center',
    right: 'text-right',
  }[alignment];

  // Shopify-style text sizing with better readability
  const fontSizeClass = {
    sm: 'text-sm leading-relaxed',
    base: 'text-base md:text-lg leading-relaxed',
    lg: 'text-lg md:text-xl leading-relaxed',
    xl: 'text-xl md:text-2xl leading-relaxed',
    '2xl': 'text-2xl md:text-3xl leading-relaxed',
  }[fontSize];

  const fontWeightClass = {
    normal: 'font-normal',
    medium: 'font-medium',
    semibold: 'font-semibold',
    bold: 'font-bold',
  }[fontWeight];

  // Text now returns just the content div - layout/width controlled by parent container
  return (
    <div
      className={`transition-colors duration-200 antialiased ${alignmentClass} ${fontSizeClass} ${fontWeightClass}`}
      style={{
        color,
        maxWidth: alignment === 'center' ? '65ch' : undefined,
        marginLeft: alignment === 'center' ? 'auto' : undefined,
        marginRight: alignment === 'center' ? 'auto' : undefined,
      }}
    >
      {content}
    </div>
  );
}
