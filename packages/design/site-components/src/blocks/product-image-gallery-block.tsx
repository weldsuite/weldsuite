"use client";

import React, { useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';

export interface ProductImageGalleryBlockProps {
  images?: string[];
  productName?: string;
  showBadge?: boolean;
  badgeText?: string;
  badgeColor?: string;
  borderRadius?: number;
  buttonBorderRadius?: number;
  layout?: 'horizontal' | 'vertical' | 'grid';
  mode?: 'live' | 'edit' | 'preview';
  store?: {
    selectedProduct?: any;
    [key: string]: any;
  };
}

export function ProductImageGalleryBlock({
  images = [
    'https://images.unsplash.com/photo-1620916566398-39f1143ab7be?w=800&h=800&fit=crop',
    'https://images.unsplash.com/photo-1556228720-195a672e8a03?w=800&h=800&fit=crop',
    'https://images.unsplash.com/photo-1556228577-2f1a7a2e7c8d?w=800&h=800&fit=crop',
    'https://images.unsplash.com/photo-1556228578-0d85b1a4d571?w=800&h=800&fit=crop',
  ],
  productName = 'Product',
  showBadge = false,
  badgeText = 'Sale',
  badgeColor = '#dc2626',
  borderRadius = 12,
  buttonBorderRadius = 9999,
  layout = 'horizontal',
  mode = 'live',
  store,
}: ProductImageGalleryBlockProps) {
  // Use product data from store if available
  const productImages = store?.selectedProduct?.images;
  const displayImages = productImages && productImages.length > 0 ? productImages : images;
  const displayName = store?.selectedProduct?.name || productName;

  const [activeImage, setActiveImage] = useState(0);

  if (layout === 'grid') {
    return (
      <div className="w-full">
        <div className="grid grid-cols-2 gap-4" style={{ width: '800px' }}>
          {displayImages.map((image: string, index: number) => (
            <div
              key={index}
              className="relative overflow-hidden bg-muted"
              style={{
                width: '398px',
                height: '398px',
                borderRadius: `${borderRadius}px`
              }}
            >
              <img
                src={image}
                alt={`${displayName} ${index + 1}`}
                className="w-full h-full object-cover"
              />
              {showBadge && badgeText && index === 0 && (
                <div
                  className="absolute top-4 left-4 px-3 py-1 rounded-full text-white text-sm font-semibold"
                  style={{ backgroundColor: badgeColor }}
                >
                  {badgeText}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (layout === 'vertical') {
    return (
      <div className="w-full flex gap-4">
        {/* Thumbnail Gallery - Left Side */}
        <div className="flex flex-col gap-2 overflow-y-auto" style={{ maxHeight: '800px' }}>
          {displayImages.map((image: string, index: number) => (
            <button
              key={index}
              onClick={() => setActiveImage(index)}
              className={cn(
                "relative w-20 h-20 transition-all flex-shrink-0 cursor-pointer",
                activeImage === index
                  ? "border-2 border-black"
                  : ""
              )}
              style={{ borderRadius: `${borderRadius}px` }}
            >
              <img
                src={image}
                alt={`${displayName} ${index + 1}`}
                className="w-full h-full object-cover"
                style={{ borderRadius: `${borderRadius - 2}px` }}
              />
            </button>
          ))}
        </div>

        {/* Main Image - Fixed width to prevent content shift */}
        <div className="relative overflow-hidden bg-muted aspect-square" style={{ width: '704px', height: '704px', borderRadius: `${borderRadius}px` }}>
          <img
            src={displayImages[activeImage]}
            alt={displayName}
            className="w-full h-full object-cover"
          />
          {showBadge && badgeText && (
            <div
              className="absolute top-4 left-4 px-3 py-1 rounded-full text-white text-sm font-semibold"
              style={{ backgroundColor: badgeColor }}
            >
              {badgeText}
            </div>
          )}
          {/* Navigation Buttons - Bottom Right */}
          <div className="absolute bottom-4 right-4 flex gap-2">
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9 shadow-none bg-white"
              style={{ borderRadius: `${buttonBorderRadius}px` }}
              onClick={() => setActiveImage(Math.max(0, activeImage - 1))}
              disabled={activeImage === 0}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9 shadow-none bg-white"
              style={{ borderRadius: `${buttonBorderRadius}px` }}
              onClick={() => setActiveImage(Math.min(displayImages.length - 1, activeImage + 1))}
              disabled={activeImage === displayImages.length - 1}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Horizontal Layout (default)
  return (
    <div className="w-full">
      {/* Main Image */}
      <div className="relative mb-4 overflow-hidden bg-muted aspect-square" style={{ height: '800px', borderRadius: `${borderRadius}px` }}>
        <img
          src={displayImages[activeImage]}
          alt={displayName}
          className="w-full h-full object-cover"
        />
        {showBadge && badgeText && (
          <div
            className="absolute top-4 left-4 px-3 py-1 rounded-full text-white text-sm font-semibold"
            style={{ backgroundColor: badgeColor }}
          >
            {badgeText}
          </div>
        )}
      </div>

      {/* Thumbnail Gallery */}
      <div className="flex items-center gap-2.5">
        <div className="flex gap-2 flex-1 overflow-x-auto">
          {displayImages.map((image: string, index: number) => (
            <button
              key={index}
              onClick={() => setActiveImage(index)}
              className={cn(
                "relative w-20 h-20 transition-all flex-shrink-0 cursor-pointer",
                activeImage === index
                  ? "border-2 border-black"
                  : ""
              )}
              style={{ borderRadius: `${borderRadius}px` }}
            >
              <img
                src={image}
                alt={`${displayName} ${index + 1}`}
                className="w-full h-full object-cover"
                style={{ borderRadius: `${borderRadius - 2}px` }}
              />
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 shadow-none"
            style={{ borderRadius: `${buttonBorderRadius}px` }}
            onClick={() => setActiveImage(Math.max(0, activeImage - 1))}
            disabled={activeImage === 0}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 shadow-none"
            style={{ borderRadius: `${buttonBorderRadius}px` }}
            onClick={() => setActiveImage(Math.min(displayImages.length - 1, activeImage + 1))}
            disabled={activeImage === displayImages.length - 1}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
