"use client";

import React from 'react';
import { ShoppingBag, Star, ArrowRight, Plus } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';

interface FeaturedCollectionSectionProps {
  sectionId?: string;
  heading?: string;
  subheading?: string;
  collectionTitle?: string;
  layout?: 'grid' | 'carousel';
  columns?: number;
  productsToShow?: number;
  showViewAll?: boolean;
  viewAllText?: string;
  viewAllLink?: string;
  backgroundColor?: string;
  textColor?: string;
  // Layout
  gapX?: number;
  gapY?: number;
  // Product Images
  imageAspectRatio?: 'square' | 'portrait' | 'landscape' | 'wide';
  imageBorderRadius?: number;
  imageHoverScale?: number;
  showQuickAdd?: boolean;
  // Product Info
  productNameSize?: number;
  productNameWeight?: number;
  productInfoSpacing?: number;
  priceSize?: number;
  priceWeight?: number;
  showRatings?: boolean;
  showBadges?: boolean;
  // Section Styling
  paddingTop?: number;
  paddingBottom?: number;
  // Header Styling
  headingSize?: number;
  headingWeight?: number;
  subheadingSize?: number;
  headerSpacing?: number;
  // Hidden elements
  hiddenElements?: string[];
  // Store data
  store?: any;
  products?: any[];
  collectionId?: string;
}

// Mock product data - Shopify style with real PNG product images
const mockProducts = [
  {
    id: 1,
    name: 'Classic Cotton T-Shirt',
    price: 29.99,
    compareAtPrice: 39.99,
    image: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=800&h=800&fit=crop&fm=png',
    badge: 'Sale',
    rating: 4.5,
    reviews: 128
  },
  {
    id: 2,
    name: 'Denim Jacket',
    price: 89.99,
    image: 'https://images.unsplash.com/photo-1576995853123-5a10305d93c0?w=800&h=800&fit=crop&fm=png',
    badge: 'New',
    rating: 4.8,
    reviews: 95
  },
  {
    id: 3,
    name: 'Leather Sneakers',
    price: 119.99,
    compareAtPrice: 149.99,
    image: 'https://images.unsplash.com/photo-1549298916-b41d501d3772?w=800&h=800&fit=crop&fm=png',
    badge: 'Sale',
    rating: 4.6,
    reviews: 203
  },
  {
    id: 4,
    name: 'Cotton Chinos',
    price: 59.99,
    image: 'https://images.unsplash.com/photo-1473966968600-fa801b869a1a?w=800&h=800&fit=crop&fm=png',
    badge: 'Best Seller',
    rating: 4.7,
    reviews: 156
  },
  {
    id: 5,
    name: 'Wool Sweater',
    price: 79.99,
    image: 'https://images.unsplash.com/photo-1576566588028-4147f3842f27?w=800&h=800&fit=crop&fm=png',
    rating: 4.4,
    reviews: 87
  },
  {
    id: 6,
    name: 'Canvas Backpack',
    price: 49.99,
    image: 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=800&h=800&fit=crop&fm=png',
    badge: 'New',
    rating: 4.9,
    reviews: 64
  },
  {
    id: 7,
    name: 'Oxford Shirt',
    price: 69.99,
    compareAtPrice: 89.99,
    image: 'https://images.unsplash.com/photo-1602810318383-e386cc2a3ccf?w=800&h=800&fit=crop&fm=png',
    badge: 'Sale',
    rating: 4.5,
    reviews: 112
  },
  {
    id: 8,
    name: 'Running Shoes',
    price: 129.99,
    image: 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=800&h=800&fit=crop&fm=png',
    badge: 'Best Seller',
    rating: 4.8,
    reviews: 289
  },
];

export function FeaturedCollectionSection({
  sectionId,
  heading = 'Featured collection',
  subheading = '',
  collectionTitle = 'Best Sellers',
  layout = 'grid',
  columns = 4,
  productsToShow = 4,
  showViewAll = false,
  viewAllText = 'View all',
  viewAllLink = '/collections/featured',
  backgroundColor = '#ffffff',
  textColor = '#000000',
  // Layout
  gapX = 16,
  gapY = 16,
  // Product Images
  imageAspectRatio = 'square',
  imageBorderRadius = 0,
  imageHoverScale = 1,
  showQuickAdd = false,
  // Product Info
  productNameSize = 14,
  productNameWeight = 400,
  productInfoSpacing = 8,
  priceSize = 14,
  priceWeight = 400,
  showRatings = false,
  showBadges = false,
  // Section Styling
  paddingTop = 48,
  paddingBottom = 48,
  // Header Styling
  headingSize = 28,
  headingWeight = 600,
  subheadingSize = 16,
  headerSpacing = 24,
  // Hidden elements
  hiddenElements = [],
  // Store data
  store,
  products,
  collectionId,
}: FeaturedCollectionSectionProps) {
  // Use real products if available, otherwise fall back to mock data
  const sourceProducts = products && products.length > 0 ? products :
                         (store?.products && store.products.length > 0 ? store.products : mockProducts);

  const displayProducts = sourceProducts.slice(0, productsToShow);

  const isElementHidden = (elementType: string) => {
    return hiddenElements?.includes(elementType) || false;
  };

  const getBadgeVariant = (badge: string): "default" | "secondary" | "destructive" | "outline" => {
    switch (badge) {
      case 'Sale':
        return 'destructive';
      case 'New':
        return 'default';
      case 'Best Seller':
        return 'secondary';
      default:
        return 'outline';
    }
  };

  const getAspectRatioClass = () => {
    switch (imageAspectRatio) {
      case 'portrait': return 'aspect-[3/4]';
      case 'landscape': return 'aspect-[4/3]';
      case 'wide': return 'aspect-[16/9]';
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
        {/* Section Header - Shadcn Style */}
        <div
          className="flex items-center justify-between"
          style={{ marginBottom: `${headerSpacing}px` }}
        >
          <div className="space-y-1">
            {!isElementHidden('heading') && (
              <h2
                className="tracking-tight"
                style={{
                  color: textColor,
                  fontSize: `${headingSize}px`,
                  fontWeight: headingWeight,
                  lineHeight: 1.2
                }}
              >
                {heading}
              </h2>
            )}
            {subheading && !isElementHidden('subheading') && (
              <p
                className="text-muted-foreground"
                style={{
                  fontSize: `${subheadingSize}px`
                }}
              >
                {subheading}
              </p>
            )}
          </div>
          {showViewAll && !isElementHidden('viewAll') && (
            <Button variant="ghost" size="sm" asChild>
              <a href={viewAllLink} className="gap-1">
                {viewAllText}
                <ArrowRight className="h-4 w-4" />
              </a>
            </Button>
          )}
        </div>

        {/* Products Grid - Shadcn Style */}
        <div
          className="grid"
          style={{
            gridTemplateColumns: `repeat(${Math.min(columns, 6)}, minmax(0, 1fr))`,
            columnGap: `${gapX}px`,
            rowGap: `${gapY}px`,
          }}
        >
          {displayProducts.map((product: any) => (
            <div key={product.id} className="group overflow-hidden">
                {/* Product Image */}
                <div className="relative overflow-hidden">
                  <div
                    className={`relative ${getAspectRatioClass()} overflow-hidden bg-[#F3F3F3]`}
                    style={{
                      borderRadius: `${imageBorderRadius}px`,
                      marginBottom: `${productInfoSpacing}px`
                    }}
                  >
                    <img
                      src={product.image || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='600' height='600' viewBox='0 0 600 600'%3E%3Crect width='600' height='600' fill='%23f3f4f6'/%3E%3Cg transform='translate(300,300)'%3E%3Crect x='-80' y='-50' width='160' height='100' rx='8' fill='none' stroke='%239ca3af' stroke-width='6'/%3E%3Crect x='-30' y='-70' width='60' height='25' rx='4' fill='%239ca3af'/%3E%3Ccircle cx='0' cy='0' r='35' fill='none' stroke='%239ca3af' stroke-width='6'/%3E%3Ccircle cx='0' cy='0' r='20' fill='none' stroke='%239ca3af' stroke-width='4'/%3E%3Cline x1='-100' y1='-70' x2='100' y2='70' stroke='%23dc2626' stroke-width='4' stroke-linecap='round'/%3E%3C/g%3E%3C/svg%3E"}
                      alt={product.name}
                      className="w-full h-full object-cover"
                      style={{
                        transition: 'transform 0.5s',
                        transform: imageHoverScale > 1 ? `scale(${imageHoverScale})` : 'scale(1)'
                      }}
                    />

                    {/* Badge - Shadcn Style */}
                    {showBadges && product.badge && (
                      <Badge
                        variant={getBadgeVariant(product.badge)}
                        className="absolute top-3 left-3 text-xs font-semibold"
                      >
                        {product.badge}
                      </Badge>
                    )}

                    {/* Quick Add Button - Shadcn Style */}
                    {showQuickAdd && (
                      <div className="absolute inset-x-3 bottom-3 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                        <Button className="w-full gap-2" size="sm">
                          <ShoppingBag className="h-4 w-4" />
                          Quick Add
                        </Button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Product Info - Shadcn Style */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: `${productInfoSpacing}px` }}>
                  <h3
                    className="text-gray-900"
                    style={{
                      fontSize: `${productNameSize}px`,
                      fontWeight: productNameWeight,
                      lineHeight: '1.4'
                    }}
                  >
                    Example product title
                  </h3>

                  {/* Rating - Shadcn Style */}
                  {showRatings && product.rating && (
                    <div className="flex items-center gap-2">
                      <div className="flex items-center">
                        {[...Array(5)].map((_, i) => (
                          <Star
                            key={i}
                            className={cn(
                              "w-3.5 h-3.5",
                              i < Math.floor(product.rating)
                                ? 'fill-primary text-primary'
                                : 'fill-muted text-muted'
                            )}
                          />
                        ))}
                      </div>
                      <span className="text-xs text-muted-foreground">({product.reviews})</span>
                    </div>
                  )}

                  {/* Price - Shadcn Style */}
                  <div className="flex items-baseline gap-2">
                    <span
                      className="text-gray-900"
                      style={{
                        fontSize: `${priceSize}px`,
                        fontWeight: priceWeight
                      }}
                    >
                      $19.99 CAD
                    </span>
                  </div>
                </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
