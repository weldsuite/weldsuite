"use client";

import React from 'react';

interface ImageBannerSectionProps {
  image?: string;
  heading?: string;
  text?: string;
  buttonText?: string;
  buttonLink?: string;
  overlayOpacity?: number;
  textColor?: string;
  contentAlignment?: 'left' | 'center' | 'right';
  minHeight?: number;
}

export function ImageBannerSection({
  image = 'https://images.unsplash.com/photo-1441984904996-e0b6ba687e04?w=1920&h=600&fit=crop',
  heading = 'New Collection',
  text = 'Explore our latest arrivals',
  buttonText = 'Shop Now',
  buttonLink = '/collections/new',
  overlayOpacity = 0.3,
  textColor = '#ffffff',
  contentAlignment = 'center',
  minHeight = 500,
}: ImageBannerSectionProps) {
  const alignmentClasses = {
    left: 'items-start text-left',
    center: 'items-center text-center',
    right: 'items-end text-right',
  };

  return (
    <section className="relative" style={{ minHeight: `${minHeight}px` }}>
      {/* Background Image */}
      <div className="absolute inset-0">
        <img
          src={image}
          alt={heading}
          className="w-full h-full object-cover"
        />
        {/* Overlay */}
        <div
          className="absolute inset-0 bg-black"
          style={{ opacity: overlayOpacity }}
        />
      </div>

      {/* Content */}
      <div className="relative h-full min-h-[500px] flex items-center justify-center px-4 md:px-8 py-20">
        <div className={`w-full flex flex-col ${alignmentClasses[contentAlignment]} gap-6`}>
          <h1
            className="text-5xl md:text-7xl font-bold tracking-tight"
            style={{ color: textColor }}
          >
            {heading}
          </h1>
          {text && (
            <p
              className="text-xl md:text-2xl"
              style={{ color: textColor, opacity: 0.9 }}
            >
              {text}
            </p>
          )}
          {buttonText && (
            <a
              href={buttonLink}
              className="inline-block px-8 py-4 bg-white text-black font-medium hover:bg-gray-100 transition-colors text-lg rounded-md"
            >
              {buttonText}
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
