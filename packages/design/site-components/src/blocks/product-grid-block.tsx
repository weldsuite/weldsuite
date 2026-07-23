"use client";

import React from 'react';
import { ProductCard } from '../components/product-card';

export interface ProductGridBlockProps {
  columns?: number;
  gap?: number;
  mobileColumns?: number;
  tabletColumns?: number;
  limit?: number;
  showQuickAdd?: boolean;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '6xl' | '7xl' | 'full';
  showNavigation?: boolean;
  title?: string;
  navigationTabs?: Array<{ id: string; label: string }>;
  collectionId?: string;
  collectionHandle?: string;
  filterBy?: 'all' | 'collection' | 'new' | 'sale' | 'category';
  store?: any;
  mode?: 'live' | 'preview';
  // Product Card Settings
  imageRatio?: '1/1' | '4/5' | '3/4' | '16/9' | 'auto';
  imageShape?: 'square' | 'rounded' | 'circle';
  cardStyle?: 'default' | 'bordered' | 'shadow' | 'elevated';
  showRatings?: boolean;
  showVendor?: boolean;
  // Padding
  paddingTop?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  paddingRight?: number;
  // Typography
  titleSize?: 'xs' | 'sm' | 'base' | 'lg' | 'xl';
  priceSize?: 'sm' | 'base' | 'lg' | 'xl';
  textAlignment?: 'left' | 'center' | 'right';
  // Hover Effects
  imageHoverEffect?: 'none' | 'zoom' | 'fade' | 'lift';
  cardHoverEffect?: 'none' | 'shadow' | 'border' | 'scale';
  // Colors
  backgroundColor?: string;
  textColor?: string;
  priceColor?: string;
}

// Mock products for demo/preview with PNG product images
const mockProducts = [
  {
    id: '1',
    name: 'Premium Wireless Headphones',
    price: 199.99,
    compareAtPrice: 249.99,
    imageUrl: 'https://via.placeholder.com/400x500/E5E7EB/6B7280.png?text=Headphones',
    images: [
      'https://via.placeholder.com/400x500/E5E7EB/6B7280.png?text=Headphones',
      'https://via.placeholder.com/400x500/D1D5DB/4B5563.png?text=Headphones+Alt'
    ],
    category: 'Electronics',
    badge: 'Sale',
    rating: 4.5,
    reviewCount: 128,
    stock: 45
  },
  {
    id: '2',
    name: 'Classic Leather Backpack',
    price: 89.99,
    imageUrl: 'https://via.placeholder.com/400x500/E5E7EB/6B7280.png?text=Backpack',
    images: [
      'https://via.placeholder.com/400x500/E5E7EB/6B7280.png?text=Backpack',
      'https://via.placeholder.com/400x500/D1D5DB/4B5563.png?text=Backpack+Alt'
    ],
    category: 'Accessories',
    rating: 4.8,
    reviewCount: 89,
    stock: 23
  },
  {
    id: '3',
    name: 'Minimalist Watch',
    price: 149.99,
    imageUrl: 'https://via.placeholder.com/400x500/E5E7EB/6B7280.png?text=Watch',
    images: [
      'https://via.placeholder.com/400x500/E5E7EB/6B7280.png?text=Watch',
      'https://via.placeholder.com/400x500/D1D5DB/4B5563.png?text=Watch+Alt'
    ],
    category: 'Watches',
    rating: 4.7,
    reviewCount: 234,
    stock: 12
  },
  {
    id: '4',
    name: 'Organic Cotton T-Shirt',
    price: 29.99,
    compareAtPrice: 39.99,
    imageUrl: 'https://via.placeholder.com/400x500/E5E7EB/6B7280.png?text=T-Shirt',
    images: [
      'https://via.placeholder.com/400x500/E5E7EB/6B7280.png?text=T-Shirt',
      'https://via.placeholder.com/400x500/D1D5DB/4B5563.png?text=T-Shirt+Alt'
    ],
    category: 'Apparel',
    badge: 'New',
    rating: 4.6,
    reviewCount: 156,
    stock: 0 // Out of stock
  },
  {
    id: '5',
    name: 'Smart Fitness Tracker',
    price: 129.99,
    imageUrl: 'https://via.placeholder.com/400x500/E5E7EB/6B7280.png?text=Fitness+Tracker',
    images: [
      'https://via.placeholder.com/400x500/E5E7EB/6B7280.png?text=Fitness+Tracker',
      'https://via.placeholder.com/400x500/D1D5DB/4B5563.png?text=Tracker+Alt'
    ],
    category: 'Electronics',
    rating: 4.4,
    reviewCount: 92,
    stock: 67
  },
  {
    id: '6',
    name: 'Ceramic Coffee Mug Set',
    price: 34.99,
    imageUrl: 'https://via.placeholder.com/400x500/E5E7EB/6B7280.png?text=Coffee+Mug',
    images: [
      'https://via.placeholder.com/400x500/E5E7EB/6B7280.png?text=Coffee+Mug',
      'https://via.placeholder.com/400x500/D1D5DB/4B5563.png?text=Mug+Alt'
    ],
    category: 'Home & Kitchen',
    rating: 4.9,
    reviewCount: 78,
    stock: 156
  },
  {
    id: '7',
    name: 'Portable Bluetooth Speaker',
    price: 79.99,
    compareAtPrice: 99.99,
    imageUrl: 'https://via.placeholder.com/400x500/E5E7EB/6B7280.png?text=Speaker',
    images: [
      'https://via.placeholder.com/400x500/E5E7EB/6B7280.png?text=Speaker',
      'https://via.placeholder.com/400x500/D1D5DB/4B5563.png?text=Speaker+Alt'
    ],
    category: 'Electronics',
    badge: 'Sale',
    rating: 4.3,
    reviewCount: 203,
    stock: 34
  },
  {
    id: '8',
    name: 'Yoga Mat Premium',
    price: 49.99,
    imageUrl: 'https://via.placeholder.com/400x500/E5E7EB/6B7280.png?text=Yoga+Mat',
    images: [
      'https://via.placeholder.com/400x500/E5E7EB/6B7280.png?text=Yoga+Mat',
      'https://via.placeholder.com/400x500/D1D5DB/4B5563.png?text=Yoga+Mat+Alt'
    ],
    category: 'Sports & Fitness',
    rating: 4.7,
    reviewCount: 145,
    stock: 89
  }
];

export function ProductGridBlock({
  columns = 4,
  gap = 16,
  mobileColumns,
  tabletColumns,
  limit = 8,
  showQuickAdd = true,
  maxWidth = '7xl',
  showNavigation = true,
  title = '',
  navigationTabs = [
    { id: 'all', label: 'Gallery' },
    { id: 'categories', label: 'Categories' },
    { id: 'new', label: 'New' }
  ],
  collectionId,
  collectionHandle,
  filterBy = 'all',
  store,
  mode = 'live',
  // Product Card Settings
  imageRatio = '4/5',
  imageShape = 'square',
  cardStyle = 'default',
  showRatings = true,
  showVendor = false,
  // Padding
  paddingTop = 0,
  paddingBottom = 0,
  paddingLeft = 0,
  paddingRight = 0,
  // Typography
  titleSize = 'base',
  priceSize = 'base',
  textAlignment = 'left',
  // Hover Effects
  imageHoverEffect = 'zoom',
  cardHoverEffect = 'none',
  // Colors
  backgroundColor,
  textColor,
  priceColor,
}: ProductGridBlockProps) {

  const [activeTab, setActiveTab] = React.useState(navigationTabs[0]?.id || 'all');

  // Debug logging
  React.useEffect(() => {
    console.log('ProductGridBlock customization props:', {
      imageRatio,
      imageShape,
      cardStyle,
      showRatings,
      showVendor,
      titleSize,
      priceSize,
      textAlignment,
      imageHoverEffect,
      cardHoverEffect,
      paddingTop,
      paddingBottom,
      textColor,
      priceColor,
      backgroundColor
    });
  }, [imageRatio, imageShape, cardStyle, showRatings, showVendor, titleSize, priceSize, textAlignment, imageHoverEffect, cardHoverEffect, paddingTop, paddingBottom, textColor, priceColor, backgroundColor]);

  // Use store products if available, otherwise use mock products for demo
  let products = store?.products || mockProducts;

  // Filter by collection first if specified
  if (filterBy === 'collection' && (collectionId || collectionHandle)) {
    products = products.filter((p: any) => {
      // Check categoryIds array (API format)
      if (collectionId && p.categoryIds && Array.isArray(p.categoryIds)) {
        return p.categoryIds.includes(collectionId);
      }
      // Fallback to single collectionId (legacy format)
      if (collectionId && p.collectionId) {
        return p.collectionId === collectionId;
      }
      // Check collection handle
      if (collectionHandle && p.collection) {
        return p.collection === collectionHandle;
      }
      return false;
    });
  }

  // Then filter products based on active tab
  let filteredProducts = products;
  if (activeTab === 'new') {
    filteredProducts = products.filter((p: any) => p.badge === 'New');
  } else if (activeTab === 'categories') {
    // For now, show all - in real implementation, this would show by category
    filteredProducts = products;
  } else if (activeTab === 'sale') {
    filteredProducts = products.filter((p: any) => p.badge === 'Sale' || p.compareAtPrice);
  }

  const displayProducts = filteredProducts.slice(0, limit);

  // Auto-calculate responsive columns if not specified (Shopify style: mobile 2, tablet 3, desktop 4)
  const autoMobileColumns = mobileColumns ?? (columns >= 3 ? 2 : columns);
  const autoTabletColumns = tabletColumns ?? (columns >= 4 ? 3 : columns);

  // Max width classes using standard Tailwind values
  const getMaxWidthClass = () => {
    switch (maxWidth) {
      case 'md':
        return 'max-w-3xl';          // Narrow: 768px
      case 'lg':
        return 'max-w-5xl';          // Old Standard: 1024px (deprecated)
      case 'xl':
        return 'max-w-[1360px]';     // Wide: 1360px (between Standard 1280px and Full Width)
      case '7xl':
        return 'max-w-7xl';          // Standard: 1280px
      case 'full':
        return 'max-w-full';         // Full Width (no constraint)
      default:
        return 'max-w-7xl';          // Default to Standard: 1280px
    }
  };

  const maxWidthClasses = getMaxWidthClass();

  // Responsive grid classes
  const gridCols = {
    1: 'lg:grid-cols-1',
    2: 'lg:grid-cols-2',
    3: 'lg:grid-cols-3',
    4: 'lg:grid-cols-4',
    5: 'lg:grid-cols-5',
    6: 'lg:grid-cols-6',
  }[columns] || 'lg:grid-cols-4';

  const mobileCols = {
    1: 'grid-cols-1',
    2: 'grid-cols-2',
  }[autoMobileColumns] || 'grid-cols-2';

  const tabletCols = {
    1: 'md:grid-cols-1',
    2: 'md:grid-cols-2',
    3: 'md:grid-cols-3',
    4: 'md:grid-cols-4',
  }[autoTabletColumns] || 'md:grid-cols-3';

  const handleAddToCart = (product: any) => {
    console.log('Add to cart:', product);
    // Cart action will be dispatched here
  };

  if (displayProducts.length === 0) {
    return (
      <div className="py-16 text-center bg-gray-50 border-2 border-dashed border-gray-200">
        <p className="text-gray-500 text-sm font-medium">No products available</p>
        <p className="text-gray-400 text-xs mt-1">Add products to see them here</p>
      </div>
    );
  }

  return (
    <div
      className={`w-full ${maxWidthClasses} mx-auto px-4 sm:px-6 lg:px-8`}
      style={{
        paddingTop: `${paddingTop}px`,
        paddingBottom: `${paddingBottom}px`,
        paddingLeft: `${paddingLeft}px`,
        paddingRight: `${paddingRight}px`,
        backgroundColor: backgroundColor,
      }}
    >
      <div className="w-full" style={{ color: textColor }}>
        {/* Navigation Tabs - Shadcn Design */}
        {showNavigation && navigationTabs.length > 0 && (
          <div className="inline-flex h-10 items-center justify-center rounded-lg p-1 border border-border mb-6">
            {navigationTabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 ${
                  activeTab === tab.id
                    ? 'text-foreground'
                    : 'text-gray-400 hover:text-foreground'
                }`}
              >
                {tab.label}
                {tab.id === 'new' && (
                  <svg className="ml-1.5 h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        )}

        {/* Title */}
        {title && (
          <h2 className="text-4xl font-bold text-gray-900 mb-12">
            {title}
          </h2>
        )}

        {/* Product Grid */}
        <div
          className={`grid ${mobileCols} ${tabletCols} ${gridCols}`}
          style={{
            gap: `${gap}px`,
            rowGap: `${gap * 1.5}px` // More vertical spacing for Shopify look
          }}
        >
          {displayProducts.map((product: any) => (
            <ProductCard
              key={product.id}
              product={product}
              onAddToCart={handleAddToCart}
              showQuickAdd={showQuickAdd}
              imageRatio={imageRatio}
              imageShape={imageShape}
              cardStyle={cardStyle}
              showRatings={showRatings}
              showVendor={showVendor}
              titleSize={titleSize}
              priceSize={priceSize}
              textAlignment={textAlignment}
              imageHoverEffect={imageHoverEffect}
              cardHoverEffect={cardHoverEffect}
              textColor={textColor}
              priceColor={priceColor}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
