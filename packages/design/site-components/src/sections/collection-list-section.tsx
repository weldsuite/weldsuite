"use client";

import React from 'react';
import { ArrowRight } from 'lucide-react';

interface Collection {
  id: number;
  name: string;
  description: string;
  image: string;
  productCount: number;
}

interface CollectionListSectionProps {
  heading?: string;
  subheading?: string;
  collections?: Collection[];
  columns?: number;
  showProductCount?: boolean;
  imageAspectRatio?: 'square' | 'portrait' | 'landscape';
  backgroundColor?: string;
  textColor?: string;
  paddingTop?: number;
  paddingBottom?: number;
  store?: any;
}

// Mock collection data
const mockCollections: Collection[] = [
  {
    id: 1,
    name: 'Summer Collection',
    description: 'Bright and breezy styles for warm weather',
    image: 'https://images.unsplash.com/photo-1523381210434-271e8be1f52b?w=800&h=800&fit=crop&fm=png',
    productCount: 24
  },
  {
    id: 2,
    name: 'Winter Essentials',
    description: 'Cozy pieces to keep you warm',
    image: 'https://images.unsplash.com/photo-1483985988355-763728e1935b?w=800&h=800&fit=crop&fm=png',
    productCount: 18
  },
  {
    id: 3,
    name: 'Accessories',
    description: 'Complete your look with the perfect accessories',
    image: 'https://images.unsplash.com/photo-1492707892479-7bc8d5a4ee93?w=800&h=800&fit=crop&fm=png',
    productCount: 42
  },
  {
    id: 4,
    name: 'New Arrivals',
    description: 'Fresh styles just landed',
    image: 'https://images.unsplash.com/photo-1560769629-975ec94e6a86?w=800&h=800&fit=crop&fm=png',
    productCount: 15
  },
  {
    id: 5,
    name: 'Sale',
    description: 'Limited time offers on selected items',
    image: 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=800&h=800&fit=crop&fm=png',
    productCount: 36
  },
  {
    id: 6,
    name: 'Best Sellers',
    description: 'Our most popular products',
    image: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=800&h=800&fit=crop&fm=png',
    productCount: 28
  }
];

export function CollectionListSection({
  heading = 'Shop by Collection',
  subheading = 'Explore our curated collections',
  collections,
  columns = 3,
  showProductCount = true,
  imageAspectRatio = 'square',
  backgroundColor = '#ffffff',
  textColor = '#000000',
  paddingTop = 60,
  paddingBottom = 60,
  store,
}: CollectionListSectionProps) {
  // Use real collections if available, otherwise fall back to mock data
  const displayCollections = collections && collections.length > 0 ? collections :
                              (store?.collections && store.collections.length > 0 ? store.collections : mockCollections);
  const getAspectRatioClass = () => {
    switch (imageAspectRatio) {
      case 'portrait': return 'aspect-[3/4]';
      case 'landscape': return 'aspect-[4/3]';
      default: return 'aspect-square';
    }
  };

  return (
    <section
      className="px-4 md:px-8"
      style={{
        backgroundColor,
        paddingTop: `${paddingTop}px`,
        paddingBottom: `${paddingBottom}px`
      }}
    >
      <div className="container mx-auto" style={{ maxWidth: '1280px' }}>
        {/* Section Header */}
        <div className="text-center mb-12">
          <h2
            className="text-4xl font-bold tracking-tight mb-3"
            style={{ color: textColor }}
          >
            {heading}
          </h2>
          {subheading && (
            <p
              className="text-lg"
              style={{ color: textColor, opacity: 0.7 }}
            >
              {subheading}
            </p>
          )}
        </div>

        {/* Collections Grid */}
        <div
          className="grid gap-6"
          style={{
            gridTemplateColumns: `repeat(${Math.min(columns, 4)}, minmax(0, 1fr))`
          }}
        >
          {displayCollections.map((collection: any) => (
            <a
              key={collection.id}
              href={`/collections/${collection.id}`}
              className="group block relative overflow-hidden bg-white transition-transform hover:-translate-y-1 duration-300"
            >
              {/* Collection Image */}
              <div className={`${getAspectRatioClass()} overflow-hidden relative`}>
                <img
                  src={collection.image}
                  alt={collection.name}
                  className="w-full h-full object-cover transition-transform group-hover:scale-105 duration-500"
                />
                {/* Overlay on hover */}
                <div className="absolute inset-0 bg-black opacity-0 group-hover:opacity-10 transition-opacity duration-300" />
              </div>

              {/* Collection Info */}
              <div className="py-4">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <h3
                    className="text-lg font-semibold group-hover:underline"
                    style={{ color: textColor }}
                  >
                    {collection.name}
                  </h3>
                  <ArrowRight
                    className="w-5 h-5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                    style={{ color: textColor }}
                  />
                </div>
                <p
                  className="text-sm mb-2"
                  style={{ color: textColor, opacity: 0.6 }}
                >
                  {collection.description}
                </p>
                {showProductCount && (
                  <p
                    className="text-xs font-medium"
                    style={{ color: textColor, opacity: 0.5 }}
                  >
                    {collection.productCount} products
                  </p>
                )}
              </div>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}
