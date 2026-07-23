"use client";

import React from 'react';

export interface CollectionBannerBlockProps {
  image?: string;
  title?: string;
  description?: string;
  productCount?: number;
  buttonText?: string;
  buttonUrl?: string;
  overlayOpacity?: number;
  textColor?: string;
  buttonColor?: string;
  mode?: 'live' | 'preview';
}

export function CollectionBannerBlock({
  image = 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=1200&h=400&fit=crop',
  title = 'Collection Name',
  description = 'Discover our curated selection of premium products',
  productCount = 24,
  buttonText = 'View All',
  buttonUrl = '#',
  overlayOpacity = 0.4,
  textColor = '#ffffff',
  buttonColor = '#ffffff',
  mode = 'live'
}: CollectionBannerBlockProps) {
  return (
    <div className="relative w-full h-64 md:h-80 lg:h-96 overflow-hidden rounded-lg">
      <img
        src={image}
        alt={title}
        className="w-full h-full object-cover"
      />

      <div
        className="absolute inset-0 bg-black"
        style={{ opacity: overlayOpacity }}
      />

      <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6">
        <h1
          className="text-3xl md:text-4xl lg:text-5xl font-bold mb-3"
          style={{ color: textColor }}
        >
          {title}
        </h1>

        {description && (
          <p
            className="text-base md:text-lg mb-2 max-w-2xl"
            style={{ color: textColor, opacity: 0.9 }}
          >
            {description}
          </p>
        )}

        {productCount > 0 && (
          <p
            className="text-sm md:text-base mb-6"
            style={{ color: textColor, opacity: 0.8 }}
          >
            {productCount} {productCount === 1 ? 'Product' : 'Products'}
          </p>
        )}

        <a
          href={buttonUrl}
          className="px-8 py-3 font-semibold rounded-lg transition-all hover:scale-105 border-2"
          style={{
            color: buttonColor,
            borderColor: buttonColor,
            backgroundColor: 'transparent',
          }}
        >
          {buttonText}
        </a>
      </div>
    </div>
  );
}
