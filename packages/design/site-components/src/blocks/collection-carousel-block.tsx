"use client";

import React, { useRef, useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface Collection {
  id: string;
  name: string;
  description?: string;
  link?: string;
  image?: string;
  productCount?: number;
}

interface CollectionSlot {
  id: string;
  collectionId?: string;
}

export interface CollectionCarouselBlockProps {
  title?: string;
  subtitle?: string;
  collectionSlots?: CollectionSlot[];
  columns?: 2 | 3 | 4 | 5;
  showProductCount?: boolean;
  showDescription?: boolean;
  imageRounding?: number;
  backgroundColor?: string;
  textColor?: string;
  mode?: 'live' | 'preview' | 'edit';
  store?: {
    collections?: Collection[];
  };
  // Card spacing
  cardSpacing?: number;
  // Arrow button customization
  showArrows?: boolean;
  arrowColor?: string;
  arrowBackgroundColor?: string;
  arrowBorderColor?: string;
  arrowBorderRadius?: number;
}

// Default collections for preview
const DEFAULT_COLLECTIONS: Collection[] = [
  {
    id: 'default-1',
    name: 'Summer Collection',
    description: 'Light and breezy styles for warm days',
    image: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/dynamic-sketches-sports-illustrated-sweatshirt.png',
    productCount: 24,
  },
  {
    id: 'default-2',
    name: 'New Arrivals',
    description: 'Fresh styles just dropped',
    image: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/bicolor-crewneck-sweatshirt-with-embroidered-logo.png',
    productCount: 18,
  },
  {
    id: 'default-3',
    name: 'Best Sellers',
    description: 'Our most popular items',
    image: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/black-hoodie-against-light-background.png',
    productCount: 32,
  },
  {
    id: 'default-4',
    name: 'Accessories',
    description: 'Complete your look',
    image: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/elegant-patent-stilettos-with-signature-red-soles.png',
    productCount: 45,
  },
  {
    id: 'default-5',
    name: 'Outerwear',
    description: 'Jackets, coats & more',
    image: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/elegant-peach-scarf.png',
    productCount: 16,
  },
  {
    id: 'default-6',
    name: 'Bags & Purses',
    description: 'Carry in style',
    image: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/maroon-leather-handbag.png',
    productCount: 28,
  },
  {
    id: 'default-7',
    name: 'Basics',
    description: 'Everyday essentials',
    image: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/minimalist-tank-top-flatlay.png',
    productCount: 52,
  },
  {
    id: 'default-8',
    name: 'Sale',
    description: 'Up to 50% off',
    image: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/modern-handbag-display.png',
    productCount: 67,
  },
];

const DEFAULT_SLOTS: CollectionSlot[] = [
  { id: 'slot-1' },
  { id: 'slot-2' },
  { id: 'slot-3' },
  { id: 'slot-4' },
];

export function CollectionCarouselBlock({
  title = 'Most Popular',
  subtitle = '',
  collectionSlots = DEFAULT_SLOTS,
  columns = 4,
  showProductCount = true,
  showDescription = false,
  imageRounding = 0,
  backgroundColor = '#ffffff',
  textColor = '#171717',
  mode = 'live',
  store,
  cardSpacing = 16,
  showArrows = true,
  arrowColor,
  arrowBackgroundColor = 'transparent',
  arrowBorderColor,
  arrowBorderRadius = 20,
}: CollectionCarouselBlockProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  // Check if we need carousel (more collections than columns)
  const needsCarousel = collectionSlots.length > columns;

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
  }, [collectionSlots.length, columns]);

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

  // Get collection for a slot from store or use default
  const getCollectionForSlot = (slot: CollectionSlot, index: number): Collection => {
    if (slot.collectionId && store?.collections) {
      const storeCollection = store.collections.find(c => c.id === slot.collectionId);
      if (storeCollection) return storeCollection;
    }
    // Return default collection for this slot index. `index % length` is always
    // in bounds, so the lookup is safe — the assertion satisfies
    // noUncheckedIndexedAccess without a runtime fallback.
    return DEFAULT_COLLECTIONS[index % DEFAULT_COLLECTIONS.length]!;
  };

  const getCollectionLink = (collection: Collection): string => {
    return collection.link || `/collections/${collection.id}`;
  };

  // Collection card component to avoid duplication
  const CollectionCard = ({ slot, index }: { slot: CollectionSlot; index: number }) => {
    const collection = getCollectionForSlot(slot, index);
    return (
      <a
        href={getCollectionLink(collection)}
        className="block group"
        onClick={(e) => mode !== 'live' && e.preventDefault()}
      >
        {/* Image */}
        <div
          className="relative overflow-hidden bg-gray-100 aspect-[3/4] mb-3"
          style={{ borderRadius: imageRounding }}
        >
          <img
            src={collection.image}
            alt={collection.name}
            className="w-full h-full object-cover object-center transition-transform duration-300 group-hover:scale-105"
          />
          {/* Overlay on hover */}
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors duration-300" />
        </div>

        {/* Content */}
        <div className="px-1">
          <h3
            className="text-sm font-medium mb-0.5 group-hover:underline"
            style={{ color: textColor }}
          >
            {collection.name}
          </h3>
          {showDescription && collection.description && (
            <p className="text-xs text-gray-500 mb-1 line-clamp-1">
              {collection.description}
            </p>
          )}
          {showProductCount && collection.productCount !== undefined && (
            <p className="text-xs text-gray-500">
              {collection.productCount} {collection.productCount === 1 ? 'product' : 'products'}
            </p>
          )}
        </div>
      </a>
    );
  };

  return (
    <section
      className="px-5 py-16"
      style={{ backgroundColor }}
    >
      <div className="max-w-7xl mx-auto">
        {/* Header with title and arrows */}
        <div className={`flex items-center mb-8 ${title ? 'justify-between' : 'justify-end'}`}>
          {title && (
            <h2
              className="text-2xl font-semibold tracking-tight"
              style={{ color: textColor }}
            >
              {title}
              {subtitle && (
                <span className="ml-3 text-sm font-normal text-gray-400">
                  {subtitle}
                </span>
              )}
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
            {collectionSlots.map((slot, index) => (
              <div
                key={slot.id}
                className="flex-shrink-0"
                style={{ width: getItemWidth() }}
              >
                <CollectionCard slot={slot} index={index} />
              </div>
            ))}
          </div>
        ) : (
          // Regular grid layout
          <div
            className={`grid ${gridCols[columns]}`}
            style={{ columnGap: cardSpacing, rowGap: cardSpacing * 2 }}
          >
            {collectionSlots.map((slot, index) => (
              <CollectionCard key={slot.id} slot={slot} index={index} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
