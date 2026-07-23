"use client";

import React from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Heart, ShoppingBag, ArrowRight, Star, ChevronRight } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';

export interface FeaturedCollectionBlockProps {
  heading?: string;
  subheading?: string;
  collectionId?: string;
  collectionHandle?: string;
  productsPerRow?: 2 | 3 | 4;
  rows?: 1 | 2 | 3;
  showViewAll?: boolean;
  viewAllText?: string;
  viewAllLink?: string;
  backgroundColor?: string;
  textColor?: string;
  cardBackgroundColor?: string;
  buttonVariant?: 'primary' | 'secondary' | 'outline';
  imageAspectRatio?: 'square' | 'portrait' | 'landscape';
  showQuickAdd?: boolean;
  mode?: 'live' | 'edit' | 'preview';
  store?: any;
}

export function FeaturedCollectionBlock({
  heading = 'Featured Collection',
  subheading = '',
  collectionId = '',
  collectionHandle = '',
  productsPerRow = 4,
  rows = 1,
  showViewAll = true,
  viewAllText = 'View all',
  viewAllLink = '/collections/all',
  backgroundColor = '#ffffff',
  textColor = '#000000',
  cardBackgroundColor = '#ffffff',
  buttonVariant = 'primary',
  imageAspectRatio = 'square',
  showQuickAdd = true,
  mode = 'live',
  store,
}: FeaturedCollectionBlockProps) {
  const isEditing = mode === 'edit' || mode === 'preview';

  // Get products from store
  let products = store?.products || [];

  // Filter by collection if specified
  if (collectionId) {
    products = products.filter((p: any) => {
      // Check categoryIds array (API format)
      if (p.categoryIds && Array.isArray(p.categoryIds)) {
        return p.categoryIds.includes(collectionId);
      }
      // Fallback to single collectionId (legacy format)
      if (p.collectionId) {
        return p.collectionId === collectionId;
      }
      return false;
    });
  } else if (collectionHandle) {
    products = products.filter((p: any) => p.collection === collectionHandle);
  }

  const displayProducts = products.slice(0, productsPerRow * rows);

  console.log('FeaturedCollectionBlock:', {
    collectionId,
    collectionHandle,
    allProductsCount: store?.products?.length,
    filteredProductsCount: products.length,
    displayProductsCount: displayProducts.length,
  });

  // Placeholder products for empty state
  const placeholderProducts = Array.from({ length: productsPerRow * rows }, (_, i) => ({
    id: `placeholder-${i}`,
    name: `Product ${i + 1}`,
    price: 99.99,
    image: `https://images.unsplash.com/photo-${1523275335684 + i}?w=400&h=400&fit=crop`,
  }));

  const finalProducts = displayProducts.length > 0 ? displayProducts : placeholderProducts;

  const gridColumns = {
    2: 'grid-cols-2',
    3: 'grid-cols-2 md:grid-cols-3',
    4: 'grid-cols-2 md:grid-cols-4',
  };

  const aspectRatioClasses = {
    square: 'aspect-square',
    portrait: 'aspect-[3/4]',
    landscape: 'aspect-[4/3]',
  };

  const buttonVariantClasses = {
    primary: 'bg-black text-white hover:bg-gray-800',
    secondary: 'bg-white text-black border border-gray-300 hover:bg-gray-50',
    outline: 'bg-transparent border-2 border-current hover:bg-black/5',
  };

  return (
    <div
      className="w-full py-12 md:py-16"
      style={{ backgroundColor }}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header - Shadcn Style */}
        <div className="flex items-center justify-between mb-8 md:mb-12">
          <div className="flex items-center gap-3">
            <h2
              className="text-3xl md:text-4xl font-bold tracking-tight"
              style={{ color: textColor }}
            >
              {heading}
            </h2>
            <div className="w-7 h-7 rounded-full bg-gray-200 flex items-center justify-center mt-1">
              <ChevronRight className="w-5 h-5 text-gray-500" strokeWidth={3} />
            </div>
          </div>
          {showViewAll && (
            <Button
              variant="ghost"
              size="sm"
              asChild
              className="hidden md:inline-flex gap-1"
            >
              <a href={isEditing ? undefined : viewAllLink} onClick={(e) => isEditing && e.preventDefault()}>
                {viewAllText}
                <ArrowRight className="h-4 w-4" />
              </a>
            </Button>
          )}
        </div>

        {/* Product Grid - Shadcn Style */}
        <div className={`grid ${gridColumns[productsPerRow]} gap-4 md:gap-6`}>
          {finalProducts.map((product: any) => (
            <div
              key={product.id}
              className="group"
            >
              <div>
                {/* Product Image */}
                <div className="relative overflow-hidden mb-4">
                  <div className={`relative ${aspectRatioClasses[imageAspectRatio]} overflow-hidden bg-muted border border-border rounded-md hover:shadow-md transition-all duration-300`}>
                    <img
                      src={product.image || 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400&h=400&fit=crop'}
                      alt={product.name}
                      className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
                    />

                    {/* Favorite Icon */}
                    <Button
                      size="icon"
                      variant="secondary"
                      className="absolute top-3 right-3 h-8 w-8 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={(e) => isEditing && e.preventDefault()}
                    >
                      <Heart className="h-4 w-4" />
                    </Button>

                    {/* Quick Add Button */}
                    {showQuickAdd && (
                      <div className="absolute inset-x-3 bottom-3 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                        <Button
                          className="w-full gap-2"
                          size="sm"
                          onClick={(e) => isEditing && e.preventDefault()}
                        >
                          <ShoppingBag className="h-4 w-4" />
                          Quick Add
                        </Button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Product Info - Shadcn Style */}
                <div className="space-y-2">
                  <h3 className="font-medium line-clamp-2 leading-tight">
                    {product.name}
                  </h3>

                  {/* Rating */}
                  <div className="flex items-center gap-2">
                    <div className="flex items-center">
                      {[...Array(5)].map((_, i) => (
                        <Star
                          key={i}
                          className={cn(
                            "w-3.5 h-3.5",
                            i < 4
                              ? 'fill-primary text-primary'
                              : 'fill-muted text-muted'
                          )}
                        />
                      ))}
                    </div>
                    <span className="text-xs text-muted-foreground">(128)</span>
                  </div>

                  {/* Price */}
                  <div className="flex items-baseline gap-2 -mt-1">
                    <span className="font-semibold text-base">
                      ${(() => {
                        if (!product.price) return '0.00';
                        // Handle Money object
                        if (typeof product.price === 'object' && 'amount' in product.price) {
                          return product.price.amount.toFixed(2);
                        }
                        // Handle number
                        if (typeof product.price === 'number') {
                          return product.price.toFixed(2);
                        }
                        // Handle string
                        const parsed = parseFloat(product.price);
                        return isNaN(parsed) ? '0.00' : parsed.toFixed(2);
                      })()}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* View All Button - Mobile Only */}
        {showViewAll && (
          <div className="flex justify-center mt-8 md:hidden">
            <Button
              variant="outline"
              size="lg"
              asChild
              className="gap-1"
            >
              <a href={isEditing ? undefined : viewAllLink} onClick={(e) => isEditing && e.preventDefault()}>
                {viewAllText}
                <ArrowRight className="h-4 w-4" />
              </a>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
