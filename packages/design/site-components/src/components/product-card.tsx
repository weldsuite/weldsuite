"use client";

import React from 'react';
import { Heart, Plus } from 'lucide-react';
import type { Product } from '../types';
import { toImageUrls } from '../lib/product-images';
import { toPriceNumber } from '../lib/price';

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

const IMAGE_RATIO_CLASSES: Record<string, string> = {
  '1/1': 'aspect-square',
  '4/5': 'aspect-[4/5]',
  '3/4': 'aspect-[3/4]',
  '16/9': 'aspect-video',
  auto: '',
};

const IMAGE_SHAPE_CLASSES: Record<string, string> = {
  square: '',
  rounded: 'rounded-lg',
  circle: 'rounded-full',
};

const CARD_STYLE_CLASSES: Record<string, string> = {
  default: '',
  bordered: 'border border-gray-200',
  shadow: 'shadow-md',
  elevated: 'shadow-lg hover:shadow-xl',
};

const TITLE_SIZE_CLASSES: Record<string, string> = {
  xs: 'text-xs',
  sm: 'text-sm',
  base: 'text-base',
  lg: 'text-lg',
  xl: 'text-xl',
};

const PRICE_SIZE_CLASSES: Record<string, string> = {
  sm: 'text-sm',
  base: 'text-base',
  lg: 'text-lg',
  xl: 'text-xl',
};

const TEXT_ALIGNMENT_CLASSES: Record<string, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

const PRICE_JUSTIFY_CLASSES: Record<string, string> = {
  center: 'justify-center',
  right: 'justify-end',
};

const IMAGE_HOVER_EFFECT_CLASSES: Record<string, string> = {
  none: '',
  zoom: 'group-hover:scale-110 transition-transform duration-500',
  fade: 'group-hover:opacity-80 transition-opacity duration-500',
  lift: 'group-hover:-translate-y-2 transition-transform duration-500',
};

const CARD_HOVER_EFFECT_CLASSES: Record<string, string> = {
  none: '',
  shadow: 'hover:shadow-lg transition-shadow duration-300',
  border: 'hover:border-gray-400 transition-colors duration-300',
  scale: 'hover:scale-105 transition-transform duration-300',
};

interface ProductRatingProps {
  rating?: number;
  reviewCount?: number;
}

function ProductRating({ rating, reviewCount }: Readonly<ProductRatingProps>) {
  if (!rating) return null;
  return (
    <div className="flex items-center gap-1">
      <div className="flex">
        {[...new Array(5)].map((_, i) => (
          <svg
            key={i}
            className={`w-3 h-3 ${i < Math.floor(rating) ? 'text-black' : 'text-gray-300'}`}
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path d="M10 15l-5.878 3.09 1.123-6.545L.489 6.91l6.572-.955L10 0l2.939 5.955 6.572.955-4.756 4.635 1.123 6.545z" />
          </svg>
        ))}
      </div>
      {reviewCount ? (
        <span className="text-xs text-gray-500">({reviewCount})</span>
      ) : null}
    </div>
  );
}

function getPricing(product: Product) {
  const price = toPriceNumber(product.price);
  const compareAtPrice = product.compareAtPrice ? toPriceNumber(product.compareAtPrice) : null;
  return {
    price,
    formattedPrice: `$${price.toFixed(2)}`,
    // Compare at price (sale price)
    formattedComparePrice: compareAtPrice ? `$${compareAtPrice.toFixed(2)}` : null,
    onSale: !!compareAtPrice && compareAtPrice > price,
    isOutOfStock: product.stock !== undefined && product.stock <= 0,
  };
}

interface ProductCardImagesProps {
  name?: string;
  imageUrl?: string;
  secondImage?: string;
  isHovered: boolean;
  imageHoverEffectClass: string;
}

function ProductCardImages({ name, imageUrl, secondImage, isHovered, imageHoverEffectClass }: Readonly<ProductCardImagesProps>) {
  // Gray placeholder when no image
  if (!imageUrl) return <div className="absolute inset-0 w-full h-full bg-gray-200" />;

  return (
    <>
      {/* Main Image */}
      <img
        src={imageUrl}
        alt={name}
        loading="lazy"
        className={`absolute inset-0 w-full h-full object-cover ${imageHoverEffectClass} ${
          isHovered && secondImage ? 'opacity-0' : 'opacity-100'
        } transition-opacity duration-300`}
      />

      {/* Secondary Image on Hover (Shopify pattern) */}
      {secondImage && (
        <img
          src={secondImage}
          alt={`${name} alternate view`}
          loading="lazy"
          className={`absolute inset-0 w-full h-full object-cover ${imageHoverEffectClass} ${
            isHovered ? 'opacity-100' : 'opacity-0'
          } transition-opacity duration-300`}
        />
      )}
    </>
  );
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
}: Readonly<ProductCardProps>) {
  const [isHovered, setIsHovered] = React.useState(false);
  const [isFavorited, setIsFavorited] = React.useState(false);

  const productImages = toImageUrls(product.images);
  const imageUrl = product.imageUrl || productImages[0];
  const secondImage = productImages[1];

  const { formattedPrice, formattedComparePrice, onSale, isOutOfStock } = getPricing(product);

  const imageRatioClass = IMAGE_RATIO_CLASSES[imageRatio] ?? 'aspect-[4/5]';
  const imageShapeClass = IMAGE_SHAPE_CLASSES[imageShape] ?? '';
  const cardStyleClass = CARD_STYLE_CLASSES[cardStyle] ?? '';
  const titleSizeClass = TITLE_SIZE_CLASSES[titleSize] ?? 'text-sm';
  const priceSizeClass = PRICE_SIZE_CLASSES[priceSize] ?? 'text-sm';
  const textAlignmentClass = TEXT_ALIGNMENT_CLASSES[textAlignment] ?? 'text-left';
  const priceJustifyClass = PRICE_JUSTIFY_CLASSES[textAlignment] ?? 'justify-start';
  const imageHoverEffectClass = IMAGE_HOVER_EFFECT_CLASSES[imageHoverEffect] ?? '';
  const cardHoverEffectClass = CARD_HOVER_EFFECT_CLASSES[cardHoverEffect] ?? '';

  return (
    <div
      className={`group relative flex flex-col h-full ${cardStyleClass} ${cardHoverEffectClass}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Image Container */}
      <div className={`relative ${imageRatioClass} overflow-hidden bg-gray-200 mb-4 ${imageShapeClass}`}>
        <a href="#" className="block w-full h-full">
          <ProductCardImages
            name={product.name}
            imageUrl={imageUrl}
            secondImage={secondImage}
            isHovered={isHovered}
            imageHoverEffectClass={imageHoverEffectClass}
          />
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
      <div className={`flex flex-col gap-1 ${textAlignmentClass}`}>
        {/* Vendor/Category */}
        {showVendor && product.category && (
          <p className="text-xs text-gray-500 uppercase tracking-wide" style={{ color: textColor }}>
            {typeof product.category === 'string' ? product.category : product.category.name}
          </p>
        )}

        {/* Product Name */}
        <a href="#" className="group-hover:underline">
          <h3 className={`${titleSizeClass} font-normal line-clamp-2`} style={{ color: textColor || '#111827' }}>
            {product.name}
          </h3>
        </a>

        {/* Rating (if available) */}
        {showRatings && <ProductRating rating={product.rating} reviewCount={product.reviewCount} />}

        {/* Price */}
        <div className={`flex items-center gap-2 mt-1 ${priceJustifyClass}`}>
          <span className={`${priceSizeClass} font-medium`} style={{ color: priceColor || '#111827' }}>
            {formattedPrice}
          </span>
          {onSale && formattedComparePrice && (
            <span className={`${priceSizeClass} text-gray-500 line-through`}>
              {formattedComparePrice}
            </span>
          )}
        </div>

        {/* Color Swatches (if available) */}
        {productImages.length > 2 && (
          <div className="flex gap-1 mt-2">
            {productImages.slice(0, 4).map((img, idx) => (
              <button
                key={idx}
                className="w-6 h-6 rounded-full border-2 border-gray-200 hover:border-black transition-colors overflow-hidden"
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
