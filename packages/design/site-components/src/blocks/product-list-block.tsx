"use client";

import React, { useRef, useState, useEffect } from 'react';
import { Heart, ShoppingBag, ChevronLeft, ChevronRight } from 'lucide-react';

interface Product {
  id: string;
  name: string;
  link?: string;
  image?: string;
  images?: { url: string }[];
  price: number;
  compareAtPrice?: number;
  salePrice?: number;
  discountPercent?: string;
  currency?: string;
}

interface ProductSlot {
  id: string;
  productId?: string;
}

export type DiscountTagPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export type CardFormat = 'portrait' | 'square' | 'landscape' | 'wide';
export type ProductListLayout = 'contained' | 'fullWidth';

export interface ProductListBlockProps {
  title?: string;
  titleFont?: string;
  productSlots?: ProductSlot[];
  columns?: 2 | 3 | 4 | 5;
  showWishlist?: boolean;
  backgroundColor?: string;
  textColor?: string;
  imageRounding?: number;
  discountTagPosition?: DiscountTagPosition;
  cardFormat?: CardFormat;
  layout?: ProductListLayout;
  mode?: 'live' | 'preview' | 'edit';
  store?: {
    products?: Product[];
  };
  // Arrow button customization
  showArrows?: boolean;
  arrowColor?: string;
  arrowBackgroundColor?: string;
  arrowBorderColor?: string;
  arrowBorderRadius?: number;
  // Card spacing
  cardSpacing?: number;
}

// Default placeholder products (shown when no real product is selected)
const DEFAULT_PRODUCTS: Product[] = [
  {
    id: 'default-1',
    name: 'Illustrated Sweatshirt',
    link: '#',
    image: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/dynamic-sketches-sports-illustrated-sweatshirt.png',
    price: 59.00,
    salePrice: 49.00,
    discountPercent: '-30%',
    currency: 'USD',
  },
  {
    id: 'default-2',
    name: 'Crewneck Sweatshirt',
    link: '#',
    image: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/bicolor-crewneck-sweatshirt-with-embroidered-logo.png',
    price: 80.00,
    currency: 'USD',
  },
  {
    id: 'default-3',
    name: 'Black Hoodie',
    link: '#',
    image: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/black-hoodie-against-light-background.png',
    price: 75.00,
    currency: 'USD',
  },
  {
    id: 'default-4',
    name: 'Elegant Patent Stilettos',
    link: '#',
    image: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/elegant-patent-stilettos-with-signature-red-soles.png',
    price: 75.00,
    currency: 'USD',
  },
  {
    id: 'default-5',
    name: 'Elegant Peach Scarf',
    link: '#',
    image: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/elegant-peach-scarf.png',
    price: 35.00,
    currency: 'USD',
  },
  {
    id: 'default-6',
    name: 'Maroon Leather Handbag',
    link: '#',
    image: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/maroon-leather-handbag.png',
    price: 850.00,
    currency: 'USD',
  },
  {
    id: 'default-7',
    name: 'Minimalist Tank Top',
    link: '#',
    image: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/minimalist-tank-top-flatlay.png',
    price: 75.00,
    currency: 'USD',
  },
  {
    id: 'default-8',
    name: 'Modern Handbag',
    link: '#',
    image: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/modern-handbag-display.png',
    price: 850.00,
    currency: 'USD',
  },
];

const DEFAULT_SLOTS: ProductSlot[] = [
  { id: 'slot-1' },
  { id: 'slot-2' },
  { id: 'slot-3' },
  { id: 'slot-4' },
];

const formatPrice = (price: number, currency: string) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency,
  }).format(price);
};

export function ProductListBlock({
  title = 'Suggestions just for you',
  titleFont = 'Inter',
  productSlots = DEFAULT_SLOTS,
  columns = 4,
  showWishlist = true,
  backgroundColor = '#ffffff',
  textColor = '#171717',
  imageRounding = 0,
  discountTagPosition = 'top-left',
  cardFormat = 'portrait',
  layout = 'contained',
  mode = 'live',
  store,
  showArrows = true,
  arrowColor,
  arrowBackgroundColor = 'transparent',
  arrowBorderColor,
  arrowBorderRadius = 20,
  cardSpacing = 16,
}: ProductListBlockProps) {
  const isFullWidth = layout === 'fullWidth';
  const isEditMode = mode === 'edit';
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  // Check if we need carousel (more products than columns)
  const needsCarousel = productSlots.length > columns;

  // Calculate item width based on columns and spacing
  const getItemWidth = () => {
    return `calc((100% - ${(columns - 1) * cardSpacing}px) / ${columns})`;
  };

  // Update scroll button visibility
  const updateScrollButtons = () => {
    if (scrollContainerRef.current) {
      const { scrollLeft, scrollWidth, clientWidth } = scrollContainerRef.current;
      setCanScrollLeft(scrollLeft > 0);
      setCanScrollRight(scrollLeft < scrollWidth - clientWidth - 1);
    }
  };

  useEffect(() => {
    updateScrollButtons();
    const container = scrollContainerRef.current;
    if (container) {
      container.addEventListener('scroll', updateScrollButtons);
      window.addEventListener('resize', updateScrollButtons);
      return () => {
        container.removeEventListener('scroll', updateScrollButtons);
        window.removeEventListener('resize', updateScrollButtons);
      };
    }
  }, [productSlots.length, columns]);

  const scroll = (direction: 'left' | 'right') => {
    if (scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      const itemWidth = container.clientWidth / columns;
      const scrollAmount = itemWidth * Math.floor(columns / 2 || 1);
      container.scrollBy({
        left: direction === 'left' ? -scrollAmount : scrollAmount,
        behavior: 'smooth'
      });
    }
  };

  const gridCols = {
    2: 'grid-cols-1 sm:grid-cols-2',
    3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
    4: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4',
    5: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5',
  };

  const discountTagPositionClasses: Record<DiscountTagPosition, string> = {
    'top-left': 'top-2 left-2',
    'top-right': 'top-2 right-2',
    'bottom-left': 'bottom-2 left-2',
    'bottom-right': 'bottom-2 right-2',
  };

  const cardFormatClasses: Record<CardFormat, string> = {
    'portrait': 'aspect-[3/4]',
    'square': 'aspect-square',
    'landscape': 'aspect-[4/3]',
    'wide': 'aspect-[16/9]',
  };

  // Get actual products from store based on productIds, or use default product
  const getProductForSlot = (slot: ProductSlot, index: number): Product => {
    if (slot.productId && store?.products) {
      const storeProduct = store.products.find(p => p.id === slot.productId);
      if (storeProduct) return storeProduct;
    }
    // Return default product for this slot index
    return DEFAULT_PRODUCTS[index % DEFAULT_PRODUCTS.length];
  };

  const getProductImage = (product: Product | null): string => {
    if (!product) return '';
    if (product.image) return product.image;
    if (product.images && product.images.length > 0) return product.images[0].url;
    return '';
  };

  const getProductLink = (product: Product | null): string => {
    if (!product) return '#';
    return product.link || `/products/${product.id}`;
  };

  const hasDiscount = (product: Product): boolean => {
    return !!(product.compareAtPrice && product.compareAtPrice > product.price) || !!product.salePrice;
  };

  const getDiscountPercent = (product: Product): string | null => {
    if (product.discountPercent) return product.discountPercent;
    const originalPrice = product.compareAtPrice || product.price;
    const salePrice = product.salePrice || product.price;
    if (originalPrice > salePrice) {
      const discount = Math.round((1 - salePrice / originalPrice) * 100);
      return `-${discount}%`;
    }
    return null;
  };

  // Product card component to avoid duplication
  const ProductCard = ({ slot, index }: { slot: ProductSlot; index: number }) => {
    const product = getProductForSlot(slot, index);
    return (
      <div className="group">
        <a
          href={getProductLink(product)}
          className="block"
          onClick={(e) => mode !== 'live' && e.preventDefault()}
        >
          <div
            className={`relative overflow-hidden bg-gray-100 ${cardFormatClasses[cardFormat]} mb-3`}
            style={{ borderRadius: imageRounding }}
          >
            <img
              src={getProductImage(product)}
              alt={product.name}
              className="w-full h-full object-cover object-center transition-transform duration-300 group-hover:scale-105"
            />
            {hasDiscount(product) && getDiscountPercent(product) && (
              <span className={`absolute ${discountTagPositionClasses[discountTagPosition]} bg-red-600 text-white text-xs px-2 py-1 rounded`}>
                {getDiscountPercent(product)}
              </span>
            )}
            <div className="absolute bottom-0 left-0 right-0 opacity-0 translate-y-full transition-all duration-300 group-hover:opacity-100 group-hover:translate-y-0 hidden lg:block">
              <button className="w-full text-xs uppercase font-medium py-4 bg-white/90 hover:bg-gray-200 transition-colors">
                Add to Cart
              </button>
            </div>
          </div>
        </a>
        <div className="flex items-start justify-between gap-2 px-1">
          <a
            href={getProductLink(product)}
            className="flex-1"
            onClick={(e) => mode !== 'live' && e.preventDefault()}
          >
            <h3
              className="text-xs font-normal mb-1 line-clamp-2"
              style={{ color: textColor }}
            >
              {product.name}
            </h3>
            <div className="flex flex-wrap items-center gap-2">
              {hasDiscount(product) ? (
                <>
                  <span className="text-xs font-semibold text-red-600">
                    {formatPrice(product.salePrice || product.price, product.currency || 'USD')}
                  </span>
                  <span
                    className="text-xs line-through opacity-60"
                    style={{ color: textColor }}
                  >
                    {formatPrice(product.compareAtPrice || product.price, product.currency || 'USD')}
                  </span>
                </>
              ) : (
                <span
                  className="text-xs font-semibold"
                  style={{ color: textColor }}
                >
                  {formatPrice(product.price, product.currency || 'USD')}
                </span>
              )}
            </div>
          </a>
          {showWishlist && (
            <button className="p-2 rounded-full hover:bg-gray-100 transition-colors hidden lg:flex">
              <Heart className="w-4 h-4" style={{ color: textColor }} />
            </button>
          )}
          <button className="p-2 rounded-full hover:bg-gray-100 transition-colors lg:hidden">
            <ShoppingBag className="w-4 h-4" style={{ color: textColor }} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <section
      className={isFullWidth
        ? isEditMode
          ? "w-full py-16 px-5"
          : "w-screen py-16 px-5"
        : "px-5 py-16"
      }
      style={{ backgroundColor }}
    >
      <div className={isFullWidth ? "w-full" : "max-w-7xl mx-auto"}>
        {/* Header with title and arrows */}
        <div className={`flex items-center mb-8 ${title ? 'justify-between' : 'justify-end'}`}>
          {title && (
            <h2
              className="text-2xl leading-normal font-medium"
              style={{ color: textColor, fontFamily: titleFont }}
            >
              {title}
            </h2>
          )}
          {needsCarousel && showArrows && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => scroll('left')}
                className={`w-10 h-10 border flex items-center justify-center transition-all hover:opacity-80 ${
                  canScrollLeft ? 'opacity-100' : 'opacity-30 pointer-events-none'
                }`}
                style={{
                  color: arrowColor || textColor,
                  borderColor: arrowBorderColor || (textColor + '30'),
                  backgroundColor: arrowBackgroundColor,
                  borderRadius: arrowBorderRadius,
                }}
                aria-label="Scroll left"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <button
                onClick={() => scroll('right')}
                className={`w-10 h-10 border flex items-center justify-center transition-all hover:opacity-80 ${
                  canScrollRight ? 'opacity-100' : 'opacity-30 pointer-events-none'
                }`}
                style={{
                  color: arrowColor || textColor,
                  borderColor: arrowBorderColor || (textColor + '30'),
                  backgroundColor: arrowBackgroundColor,
                  borderRadius: arrowBorderRadius,
                }}
                aria-label="Scroll right"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>
          )}
        </div>

        {needsCarousel ? (
          // Carousel layout
          <div
            ref={scrollContainerRef}
            className="flex overflow-x-auto scrollbar-hide scroll-smooth"
            style={{ scrollbarWidth: 'none', msOverflowStyle: 'none', gap: cardSpacing }}
          >
            {productSlots.map((slot, index) => (
              <div
                key={slot.id}
                className="flex-shrink-0"
                style={{ width: getItemWidth() }}
              >
                <ProductCard slot={slot} index={index} />
              </div>
            ))}
          </div>
        ) : (
          // Regular grid layout
          <div
            className={`grid ${gridCols[columns]}`}
            style={{ columnGap: cardSpacing, rowGap: cardSpacing * 2 }}
          >
            {productSlots.map((slot, index) => (
              <ProductCard key={slot.id} slot={slot} index={index} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
