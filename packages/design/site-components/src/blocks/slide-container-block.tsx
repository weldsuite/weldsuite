"use client";

import React from 'react';

export interface SlideContainerBlockProps {
  backgroundImage?: string;
  overlayOpacity?: number;
  contentAlignment?: 'left' | 'center' | 'right';
  mode?: 'live' | 'edit' | 'preview';
  children?: React.ReactNode;
}

export function SlideContainerBlock({
  backgroundImage = 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=1920&h=600&fit=crop',
  overlayOpacity = 0.4,
  contentAlignment = 'center',
  mode = 'live',
  children,
}: SlideContainerBlockProps) {
  const getAlignmentClasses = () => {
    switch (contentAlignment) {
      case 'left':
        return 'items-start text-left';
      case 'right':
        return 'items-end text-right';
      default:
        return 'items-center text-center';
    }
  };

  return (
    <div className="absolute inset-0 w-full h-full">
      {/* Background Image */}
      <div className="absolute inset-0 w-full h-full">
        <img
          src={backgroundImage}
          alt="Slide background"
          className="w-full h-full object-cover"
        />
        {/* Gradient Overlay */}
        <div
          className="absolute inset-0 bg-gradient-to-b from-black/30 via-black/20 to-black/50"
          style={{ opacity: overlayOpacity }}
        />
      </div>

      {/* Content */}
      <div className={`absolute inset-0 w-full h-full flex flex-col justify-center ${getAlignmentClasses()} px-6 sm:px-12 md:px-16 lg:px-24 py-12`}>
        <div className={`max-w-4xl w-full ${contentAlignment === 'center' ? 'mx-auto' : ''}`}>
          {children}
        </div>
      </div>
    </div>
  );
}
