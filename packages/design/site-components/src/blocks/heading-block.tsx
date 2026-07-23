"use client";

import React from 'react';

interface HeadingBlockProps {
  content?: string;
  level?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
  alignment?: 'left' | 'center' | 'right';
  color?: string;
  fontWeight?: 'normal' | 'medium' | 'semibold' | 'bold';
  mode?: string;
}

export function HeadingBlock({
  content = 'Heading',
  level = 'h2',
  alignment = 'left',
  color = '#000000',
  fontWeight = 'bold',
  mode = 'live'
}: HeadingBlockProps) {
  const Tag = level;

  const alignmentClass = {
    left: 'text-left',
    center: 'text-center',
    right: 'text-right',
  }[alignment];

  const fontWeightClass = {
    normal: 'font-normal',
    medium: 'font-medium',
    semibold: 'font-semibold',
    bold: 'font-bold',
  }[fontWeight];

  // Shopify-inspired typography with better line heights and letter spacing
  const sizeClass = {
    h1: 'text-4xl md:text-6xl lg:text-7xl leading-[1.1] tracking-tight',
    h2: 'text-3xl md:text-5xl lg:text-6xl leading-[1.1] tracking-tight',
    h3: 'text-2xl md:text-4xl lg:text-5xl leading-[1.2] tracking-tight',
    h4: 'text-xl md:text-3xl lg:text-4xl leading-[1.3]',
    h5: 'text-lg md:text-2xl lg:text-3xl leading-[1.4]',
    h6: 'text-base md:text-xl lg:text-2xl leading-[1.4]',
  }[level];

  // Heading now returns just the tag - layout/width controlled by parent container
  return (
    <Tag
      className={`transition-colors duration-200 antialiased ${alignmentClass} ${fontWeightClass} ${sizeClass}`}
      style={{ color }}
    >
      {content}
    </Tag>
  );
}
