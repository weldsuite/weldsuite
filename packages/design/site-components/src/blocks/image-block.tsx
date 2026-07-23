"use client";

import React from 'react';

interface ImageBlockProps {
  src?: string;
  alt?: string;
  width?: string | number;
  height?: number;
  // New custom dimension props
  customWidth?: string | number;
  customHeight?: string | number;
  widthUnit?: 'px' | '%' | 'auto';
  heightUnit?: 'px' | '%' | 'auto';
  alignment?: 'left' | 'center' | 'right';
  objectFit?: 'contain' | 'cover' | 'fill' | 'none' | 'scale-down';
  borderRadius?: number;
  mode?: string;
}

export function ImageBlock({
  src = '/api/placeholder/800/600',
  alt = 'Image',
  width = 'full',
  height,
  customWidth,
  customHeight,
  widthUnit = 'px',
  heightUnit = 'px',
  alignment = 'center',
  objectFit = 'cover',
  borderRadius = 0,
  mode = 'live'
}: ImageBlockProps) {
  // Calculate dimensions - custom values take priority
  const calculatedWidth = customWidth
    ? widthUnit === 'auto'
      ? 'auto'
      : `${customWidth}${widthUnit}`
    : undefined;

  const calculatedHeight = customHeight
    ? heightUnit === 'auto'
      ? 'auto'
      : `${customHeight}${heightUnit}`
    : height
    ? `${height}px`
    : 'auto';

  // Shopify-style responsive image sizing (used when no custom width)
  const widthClass = !customWidth && typeof width === 'string' ? {
    'auto': 'w-auto',
    'full': 'w-full',
    '1/2': 'w-full md:w-1/2',
    '1/3': 'w-full md:w-1/3',
    '2/3': 'w-full md:w-2/3',
  }[width] || 'w-full' : undefined;

  const alignmentClass = {
    left: 'mr-auto',
    center: 'mx-auto',
    right: 'ml-auto',
  }[alignment];

  console.log('ImageBlock render:', {
    customWidth,
    customHeight,
    widthUnit,
    heightUnit,
    calculatedWidth,
    calculatedHeight,
    objectFit,
    borderRadius,
  });

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div
        className={`${customWidth ? '' : widthClass} ${alignmentClass} overflow-hidden`}
        style={{
          borderRadius: `${borderRadius}px`,
          width: calculatedWidth,
        }}
      >
        <img
          src={src}
          alt={alt}
          loading="lazy"
          className={customWidth ? '' : 'w-full h-full transition-transform duration-300 hover:scale-105'}
          style={{
            width: customWidth ? calculatedWidth : '100%',
            height: calculatedHeight,
            objectFit,
            display: 'block',
          }}
        />
      </div>
    </div>
  );
}
