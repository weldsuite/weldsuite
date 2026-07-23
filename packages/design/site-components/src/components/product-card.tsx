"use client";

import React from 'react';
import { ShoppingCart, Heart, Plus } from 'lucide-react';

interface Money {
  amount: number;
  currency: string;
  formatted?: string;
}

interface Product {
  id: string;
  name: string;
  price: number | string | Money;
  compareAtPrice?: number | string | Money;
  description?: string;
  imageUrl?: string;
  images?: string[];
  stock?: number;
  sku?: string;
  category?: string;
  badge?: string;
  rating?: number;
  reviewCount?: number;
}

interface ProductCardProps {
  product: Product;
  onAddToCart?: (product: Product) => void;
  showQuickAdd?: boolean;
  // Customization props
  imageRatio?: '1/1' | '4/5' | '3/4' | '16/9' | 'auto';
  imageShape?: 'square' | 'rounded' | 'circle';
  cardStyle?: 'default' | 'bordered' | 'shadow' | 'elevated';
  showRatings?: boolean;
  showVendor?: boolean;
  titleSize?: 'xs' | 'sm' | 'base' | 'lg' | 'xl';
  priceSize?: 'sm' | 'base' | 'lg' | 'xl';
  textAlignment?: 'left' | 'center' | 'right';
  imageHoverEffect?: 'none' | 'zoom' | 'fade' | 'lift';
  cardHoverEffect?: 'none' | 'shadow' | 'border' | 'scale';
  textColor?: string;
  priceColor?: string;
}

export function ProductCard({
  product,
  onAddToCart,
  showQuickAdd = true,
  imageRatio = '4/5',
  imageShape = 'square',
  cardStyle = 'default',
  showRatings = true,
  showVendor = false,
  titleSize = 'base',
  priceSize = 'base',
  textAlignment = 'left',
  imageHoverEffect = 'zoom',
  cardHoverEffect = 'none',
  textColor,
  priceColor,
}: ProductCardProps) {
  const [isHovered, setIsHovered] = React.useState(false);
  const [isFavorited, setIsFavorited] = React.useState(false);
  const [currentImageIndex, setCurrentImageIndex] = React.useState(0);

  // Debug logging (only once per product)
  React.useEffect(() => {
    console.log(`ProductCard [${product.name}] customization:`, {
      imageRatio,
      imageShape,
      cardStyle,
      showRatings,
      showVendor,
      titleSize,
      priceSize,
      textAlignment,
      imageHoverEffect,
      cardHoverEffect
    });
  }, [imageRatio, imageShape, cardStyle, showRatings, showVendor, titleSize, priceSize, textAlignment, imageHoverEffect, cardHoverEffect]);

  const imageUrl = product.imageUrl || product.images?.[0];
  const secondImage = product.images?.[1];

  // Helper function to extract price amount
  const extractPrice = (priceValue: number | string | Money | undefined): number => {
    if (!priceValue) return 0;

    // Check if it's a Money object
    if (typeof priceValue === 'object' && 'amount' in priceValue) {
      return priceValue.amount;
    }

    // Check if it's a number
    if (typeof priceValue === 'number') {
      return priceValue;
    }

    // Try to parse as string
    const parsed = parseFloat(priceValue);
    return isNaN(parsed) ? 0 : parsed;
  };

  const price = extractPrice(product.price);
  const formattedPrice = `$${price.toFixed(2)}`;
  const isOutOfStock = product.stock !== undefined && product.stock <= 0;

  // Compare at price (sale price)
  const compareAtPrice = product.compareAtPrice ? extractPrice(product.compareAtPrice) : null;
  const formattedComparePrice = compareAtPrice ? `$${compareAtPrice.toFixed(2)}` : null;
  const onSale = compareAtPrice && compareAtPrice > price;

  // Image ratio classes
  const getImageRatioClass = () => {
    switch (imageRatio) {
      case '1/1': return 'aspect-square';
      case '4/5': return 'aspect-[4/5]';
      case '3/4': return 'aspect-[3/4]';
      case '16/9': return 'aspect-video';
      case 'auto': return '';
      default: return 'aspect-[4/5]';
    }
  };

  // Image shape classes
  const getImageShapeClass = () => {
    switch (imageShape) {
      case 'square': return '';
      case 'rounded': return 'rounded-lg';
      case 'circle': return 'rounded-full';
      default: return '';
    }
  };

  // Card style classes
  const getCardStyleClass = () => {
    switch (cardStyle) {
      case 'default': return '';
      case 'bordered': return 'border border-gray-200';
      case 'shadow': return 'shadow-md';
      case 'elevated': return 'shadow-lg hover:shadow-xl';
      default: return '';
    }
  };

  // Title size classes
  const getTitleSizeClass = () => {
    switch (titleSize) {
      case 'xs': return 'text-xs';
      case 'sm': return 'text-sm';
      case 'base': return 'text-base';
      case 'lg': return 'text-lg';
      case 'xl': return 'text-xl';
      default: return 'text-sm';
    }
  };

  // Price size classes
  const getPriceSizeClass = () => {
    switch (priceSize) {
      case 'sm': return 'text-sm';
      case 'base': return 'text-base';
      case 'lg': return 'text-lg';
      case 'xl': return 'text-xl';
      default: return 'text-sm';
    }
  };

  // Text alignment classes
  const getTextAlignmentClass = () => {
    switch (textAlignment) {
      case 'left': return 'text-left';
      case 'center': return 'text-center';
      case 'right': return 'text-right';
      default: return 'text-left';
    }
  };

  // Image hover effect classes
  const getImageHoverEffectClass = () => {
    switch (imageHoverEffect) {
      case 'none': return '';
      case 'zoom': return 'group-hover:scale-110 transition-transform duration-500';
      case 'fade': return 'group-hover:opacity-80 transition-opacity duration-500';
      case 'lift': return 'group-hover:-translate-y-2 transition-transform duration-500';
      default: return '';
    }
  };

  // Card hover effect classes
  const getCardHoverEffectClass = () => {
    switch (cardHoverEffect) {
      case 'none': return '';
      case 'shadow': return 'hover:shadow-lg transition-shadow duration-300';
      case 'border': return 'hover:border-gray-400 transition-colors duration-300';
      case 'scale': return 'hover:scale-105 transition-transform duration-300';
      default: return '';
    }
  };

  return (
    <div
      className={`group relative flex flex-col h-full ${getCardStyleClass()} ${getCardHoverEffectClass()}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Image Container */}
      <div className={`relative ${getImageRatioClass()} overflow-hidden bg-gray-200 mb-4 ${getImageShapeClass()}`}>
        <a href="#" className="block w-full h-full">
          {/* Only render images if they exist */}
          {imageUrl ? (
            <>
              {/* Main Image */}
              <img
                src={imageUrl}
                alt={product.name}
                loading="lazy"
                className={`absolute inset-0 w-full h-full object-cover ${getImageHoverEffectClass()} ${
                  isHovered && secondImage ? 'opacity-0' : 'opacity-100'
                } transition-opacity duration-300`}
              />

              {/* Secondary Image on Hover (Shopify pattern) */}
              {secondImage && (
                <img
                  src={secondImage}
                  alt={`${product.name} alternate view`}
                  loading="lazy"
                  className={`absolute inset-0 w-full h-full object-cover ${getImageHoverEffectClass()} ${
                    isHovered ? 'opacity-100' : 'opacity-0'
                  } transition-opacity duration-300`}
                />
              )}
            </>
          ) : (
            /* Gray placeholder when no image */
            <div className="absolute inset-0 w-full h-full bg-gray-200" />
          )}
        </a>

        {/* Badge - Top Left (Sale, New, etc.) */}
        {(product.badge || onSale) && (
          <div className="absolute top-2 left-2 z-10">
            <span className="inline-block bg-black text-white text-xs font-medium px-2 py-1 uppercase tracking-wide">
              {onSale ? 'Sale' : product.badge}
            </span>
          </div>
        )}

        {/* Out of Stock Overlay */}
        {isOutOfStock && (
          <div className="absolute inset-0 bg-white/80 flex items-center justify-center">
            <span className="bg-white border border-gray-300 text-gray-900 text-sm font-medium px-4 py-2 uppercase tracking-wide rounded-md">
              Sold Out
            </span>
          </div>
        )}

        {/* Favorite Button - Shopify style */}
        <button
          onClick={(e) => {
            e.preventDefault();
            setIsFavorited(!isFavorited);
          }}
          className={`absolute top-2 right-2 z-10 p-2 rounded-lg transition-all duration-200 hover:bg-red-50 ${
            isFavorited ? 'text-red-600' : 'text-gray-400 hover:text-red-600'
          }`}
          aria-label={isFavorited ? 'Remove from favorites' : 'Add to favorites'}
        >
          <Heart className={`w-5 h-5 ${isFavorited ? 'fill-current' : ''}`} />
        </button>

        {/* Quick Add Button - Appears on hover */}
        {showQuickAdd && !isOutOfStock && (
          <div className={`absolute bottom-0 left-0 right-0 p-3 transition-all duration-300 ${
            isHovered ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
          }`}>
            <button
              onClick={(e) => {
                e.preventDefault();
                onAddToCart?.(product);
              }}
              className="w-full bg-white text-black text-sm font-medium py-3 px-4 border border-black hover:bg-black hover:text-white transition-all duration-200 flex items-center justify-center gap-2"
            >
              <Plus className="w-4 h-4" />
              Quick Add
            </button>
          </div>
        )}
      </div>

      {/* Product Info */}
      <div className={`flex flex-col gap-1 ${getTextAlignmentClass()}`}>
        {/* Vendor/Category */}
        {showVendor && product.category && (
          <p className="text-xs text-gray-500 uppercase tracking-wide" style={{ color: textColor }}>
            {product.category}
          </p>
        )}

        {/* Product Name */}
        <a href="#" className="group-hover:underline">
          <h3 className={`${getTitleSizeClass()} font-normal line-clamp-2`} style={{ color: textColor || '#111827' }}>
            {product.name}
          </h3>
        </a>

        {/* Rating (if available) */}
        {showRatings && product.rating && (
          <div className="flex items-center gap-1">
            <div className="flex">
              {[...Array(5)].map((_, i) => (
                <svg
                  key={i}
                  className={`w-3 h-3 ${i < Math.floor(product.rating!) ? 'text-black' : 'text-gray-300'}`}
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path d="M10 15l-5.878 3.09 1.123-6.545L.489 6.91l6.572-.955L10 0l2.939 5.955 6.572.955-4.756 4.635 1.123 6.545z" />
                </svg>
              ))}
            </div>
            {product.reviewCount && (
              <span className="text-xs text-gray-500">({product.reviewCount})</span>
            )}
          </div>
        )}

        {/* Price */}
        <div className={`flex items-center gap-2 mt-1 ${textAlignment === 'center' ? 'justify-center' : textAlignment === 'right' ? 'justify-end' : 'justify-start'}`}>
          <span className={`${getPriceSizeClass()} font-medium`} style={{ color: priceColor || '#111827' }}>
            {formattedPrice}
          </span>
          {onSale && formattedComparePrice && (
            <span className={`${getPriceSizeClass()} text-gray-500 line-through`}>
              {formattedComparePrice}
            </span>
          )}
        </div>

        {/* Color Swatches (if available) */}
        {product.images && product.images.length > 2 && (
          <div className="flex gap-1 mt-2">
            {product.images.slice(0, 4).map((img, idx) => (
              <button
                key={idx}
                className="w-6 h-6 rounded-full border-2 border-gray-200 hover:border-black transition-colors overflow-hidden"
                onMouseEnter={() => setCurrentImageIndex(idx)}
                aria-label={`View color variant ${idx + 1}`}
              >
                <img src={img} alt="" className="w-full h-full object-cover" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
