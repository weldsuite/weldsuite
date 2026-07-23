"use client";

import React from 'react';

export interface HeroBlockProps {
  heading?: string;
  subheading?: string;
  buttonText?: string;
  buttonLink?: string;
  buttonVariant?: 'primary' | 'secondary' | 'outline';
  imageUrl?: string;
  imagePosition?: 'left' | 'right';
  overlayOpacity?: number;
  textAlign?: 'left' | 'center' | 'right';
  contentPosition?: 'top' | 'center' | 'bottom';
  height?: 'small' | 'medium' | 'large' | 'full';
  backgroundColor?: string;
  textColor?: string;
  mode?: 'live' | 'edit' | 'preview';
}

export function HeroBlock({
  heading = 'Welcome to our store',
  subheading = 'Discover amazing products',
  buttonText = 'Shop now',
  buttonLink = '/shop',
  buttonVariant = 'primary',
  imageUrl = '',
  imagePosition = 'right',
  overlayOpacity = 0,
  textAlign = 'left',
  contentPosition = 'center',
  height = 'large',
  backgroundColor = '#f9fafb',
  textColor = '#000000',
  mode = 'live',
}: HeroBlockProps) {
  const isEditing = mode === 'edit' || mode === 'preview';

  const heightClasses = {
    small: 'min-h-[400px]',
    medium: 'min-h-[500px]',
    large: 'min-h-[600px]',
    full: 'min-h-screen',
  };

  const alignmentClasses = {
    left: 'text-left items-start',
    center: 'text-center items-center',
    right: 'text-right items-end',
  };

  const positionClasses = {
    top: 'justify-start',
    center: 'justify-center',
    bottom: 'justify-end',
  };

  const buttonVariantClasses = {
    primary: 'bg-black text-white hover:bg-gray-800',
    secondary: 'bg-white text-black hover:bg-gray-100',
    outline: 'bg-transparent border-2 border-current hover:bg-black/5',
  };

  return (
    <div
      className={`relative w-full ${heightClasses[height]} flex ${positionClasses[contentPosition]}`}
      style={{ backgroundColor }}
    >
      {/* Background Image */}
      {imageUrl && (
        <div className="absolute inset-0 overflow-hidden">
          <img
            src={imageUrl}
            alt=""
            className="w-full h-full object-cover"
          />
          {overlayOpacity > 0 && (
            <div
              className="absolute inset-0 bg-black"
              style={{ opacity: overlayOpacity / 100 }}
            />
          )}
        </div>
      )}

      {/* Content Container */}
      <div className="relative w-full">
        <div className={`max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-24 ${imagePosition === 'left' ? 'lg:pl-[50%]' : imagePosition === 'right' ? 'lg:pr-[50%]' : ''}`}>
          <div className={`flex flex-col ${alignmentClasses[textAlign]} gap-6 max-w-2xl ${textAlign === 'center' ? 'mx-auto' : textAlign === 'right' ? 'ml-auto' : ''}`}>
            {/* Heading */}
            <h1
              className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight leading-tight"
              style={{ color: textColor }}
            >
              {heading}
            </h1>

            {/* Subheading */}
            {subheading && (
              <p
                className="text-lg md:text-xl leading-relaxed opacity-90"
                style={{ color: textColor }}
              >
                {subheading}
              </p>
            )}

            {/* Button */}
            {buttonText && (
              <div className={textAlign === 'center' ? 'flex justify-center' : textAlign === 'right' ? 'flex justify-end' : 'flex justify-start'}>
                <a
                  href={isEditing ? undefined : buttonLink}
                  onClick={(e) => isEditing && e.preventDefault()}
                  className={`inline-flex items-center justify-center px-8 py-4 text-base font-medium rounded-lg transition-all duration-200 ${buttonVariantClasses[buttonVariant]} ${
                    isEditing ? 'pointer-events-none' : ''
                  }`}
                  style={buttonVariant === 'outline' ? { color: textColor } : {}}
                >
                  {buttonText}
                </a>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
