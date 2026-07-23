"use client";

import React from 'react';

export interface ProductCardBlockProps {
  image?: string;
  title?: string;
  price?: string;
  compareAtPrice?: string;
  badge?: string;
  badgeColor?: string;
  buttonText?: string;
  variant?: 'default' | 'compact' | 'featured';
  productUrl?: string;
  onAddToCart?: () => void;
  mode?: 'live' | 'preview';
}

export function ProductCardBlock({
  image = 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=400&h=400&fit=crop',
  title = 'Product Name',
  price = '99.00',
  compareAtPrice,
  badge,
  badgeColor = '#ef4444',
  buttonText = 'Add to Cart',
  variant = 'default',
  productUrl = '#',
  onAddToCart,
  mode = 'live'
}: ProductCardBlockProps) {
  const isCompact = variant === 'compact';
  const isFeatured = variant === 'featured';

  const handleAddToCart = (e: React.MouseEvent) => {
    e.preventDefault();
    if (onAddToCart) {
      onAddToCart();
    }
  };

  return (
    <div
      className={`group bg-white rounded-lg shadow-sm hover:shadow-lg transition-all ${
        isFeatured ? 'ring-2 ring-blue-500' : ''
      }`}
    >
      <a href={productUrl} className="block">
        <div className={`relative overflow-hidden rounded-t-lg ${isCompact ? 'aspect-square' : 'aspect-[4/3]'}`}>
          <img
            src={image}
            alt={title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
          {badge && (
            <div
              className="absolute top-3 left-3 px-3 py-1 text-white text-xs font-semibold rounded-full"
              style={{ backgroundColor: badgeColor }}
            >
              {badge}
            </div>
          )}
        </div>

        <div className={`p-${isCompact ? '3' : '4'}`}>
          <h3
            className={`font-semibold text-gray-900 mb-2 line-clamp-2 ${
              isFeatured ? 'text-lg' : isCompact ? 'text-sm' : 'text-base'
            }`}
          >
            {title}
          </h3>

          <div className="flex items-center gap-2 mb-3">
            <span className={`font-bold text-gray-900 ${isFeatured ? 'text-xl' : 'text-lg'}`}>
              ${price}
            </span>
            {compareAtPrice && (
              <span className="text-sm text-gray-500 line-through">${compareAtPrice}</span>
            )}
          </div>

          <button
            onClick={handleAddToCart}
            className={`w-full bg-black text-white font-medium rounded-lg hover:bg-gray-800 transition-colors ${
              isCompact ? 'py-2 text-sm' : 'py-2.5 text-base'
            }`}
          >
            {buttonText}
          </button>
        </div>
      </a>
    </div>
  );
}
