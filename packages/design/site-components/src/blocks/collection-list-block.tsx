"use client";

import React from 'react';
import { Heart } from 'lucide-react';

export interface CollectionListBlockProps {
  // Layout Settings
  columnsDesktop?: 1 | 2 | 3 | 4 | 5 | 6;
  columnsMobile?: 1 | 2;

  // Image Settings
  imageRatio?: 'adapt' | 'portrait' | 'square';

  // Content
  heading?: string;
  headingSize?: 'h2' | 'h1' | 'h0' | 'hxl' | 'hxxl';

  // Collections data
  collections?: Array<{
    id: string;
    title: string;
    handle: string;
    image?: string;
    description?: string;
  }>;

  // Store context
  store?: any;
}

// Mock collections for demo/preview (Shopify style)
const mockCollections = [
  {
    id: '1',
    title: 'Mars Record Needle HC-V100',
    handle: 'mars-record-needle',
    image: 'https://via.placeholder.com/400x500/F3F4F6/9CA3AF.png?text=Product',
    price: '$NaN'
  },
  {
    id: '2',
    title: 'Secrid Camera Color',
    handle: 'secrid-camera-color',
    image: 'https://via.placeholder.com/400x500/F3F4F6/9CA3AF.png?text=Product',
    price: '$NaN'
  },
  {
    id: '3',
    title: 'Philips HC-V100 Stylus CAS S',
    handle: 'philips-stylus',
    image: 'https://via.placeholder.com/400x500/F3F4F6/9CA3AF.png?text=Product',
    price: '$NaN'
  },
  {
    id: '4',
    title: 'Kraft HC-V100 Color',
    handle: 'kraft-color',
    image: 'https://via.placeholder.com/400x500/F3F4F6/9CA3AF.png?text=Product',
    price: '$NaN'
  },
];

// Collection Card Component
function CollectionCard({ collection, imageRatioClass }: { collection: any; imageRatioClass: string }) {
  const [isFavorited, setIsFavorited] = React.useState(false);

  return (
    <div className="group relative flex flex-col h-full">
      {/* Image Container - Exact same as Product Card */}
      <div className={`relative ${imageRatioClass} overflow-hidden bg-gray-200 mb-4`}>
        <a href={`/collections/${collection.handle}`} className="block w-full h-full">
          {/* Only render images if they exist */}
          {collection.image ? (
            <img
              src={collection.image}
              alt={collection.title}
              loading="lazy"
              className="absolute inset-0 w-full h-full object-cover"
            />
          ) : (
            /* Gray placeholder when no image */
            <div className="absolute inset-0 w-full h-full bg-gray-200" />
          )}
        </a>

        {/* Favorite Button - Top Right (Shopify style) */}
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

        {/* SOLD OUT Badge - Center Overlay */}
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="bg-white border border-gray-300 text-gray-900 text-sm font-medium px-6 py-2 uppercase tracking-wide rounded-sm">
            SOLD OUT
          </span>
        </div>
      </div>

      {/* Collection Info - Exact same style as Product Card */}
      <div className="flex flex-col gap-1">
        {/* Collection Title */}
        <a href={`/collections/${collection.handle}`} className="group-hover:underline">
          <h3 className="text-sm font-normal text-gray-900 line-clamp-2">
            {collection.title}
          </h3>
        </a>

        {/* Price */}
        <div className="flex items-center gap-2 mt-1">
          <span className="text-sm font-medium text-gray-900">
            {collection.price}
          </span>
        </div>
      </div>
    </div>
  );
}

export function CollectionListBlock({
  columnsDesktop = 4, // Default to 4 columns like Product Grid
  columnsMobile = 1,
  imageRatio = 'portrait', // Default to portrait (4/5) like Product Grid
  heading = 'Collections',
  headingSize = 'h1',
  collections,
  store,
}: CollectionListBlockProps) {

  // Use real collections from store if available, otherwise fall back to mock
  const displayCollections = React.useMemo(() => {
    // Priority: passed collections prop > store.collections > mock collections
    if (collections && collections.length > 0) {
      return collections;
    }
    if (store?.collections && store.collections.length > 0) {
      // Map API collections to the format expected by the component
      return store.collections.map((cat: any) => ({
        id: cat.id,
        title: cat.name,
        handle: cat.slug || cat.id,
        image: cat.image || cat.banner,
        description: cat.description,
      }));
    }
    // Fallback to mock collections for preview
    return mockCollections;
  }, [collections, store?.collections]);

  // Debug logging
  console.log('=== CollectionListBlock render ===', {
    columnsDesktop,
    columnsMobile,
    imageRatio,
    heading,
    headingSize,
    collections,
    storeCollections: store?.collections,
    mockCollections,
    displayCollections,
    displayCollectionsLength: displayCollections?.length,
    hasDisplayCollections: !!displayCollections,
    isArray: Array.isArray(displayCollections)
  });

  // Auto-calculate responsive columns (Shopify style: mobile 2, tablet 3, desktop configurable)
  const autoMobileColumns = columnsMobile ?? (columnsDesktop >= 3 ? 2 : columnsDesktop);
  const autoTabletColumns = columnsDesktop >= 4 ? 3 : columnsDesktop;

  // Responsive grid classes - matching Product Grid
  const gridCols = {
    1: 'lg:grid-cols-1',
    2: 'lg:grid-cols-2',
    3: 'lg:grid-cols-3',
    4: 'lg:grid-cols-4',
    5: 'lg:grid-cols-5',
    6: 'lg:grid-cols-6',
  }[columnsDesktop] || 'lg:grid-cols-4';

  const mobileCols = {
    1: 'grid-cols-1',
    2: 'grid-cols-2',
  }[autoMobileColumns] || 'grid-cols-2';

  const tabletCols = {
    1: 'md:grid-cols-1',
    2: 'md:grid-cols-2',
    3: 'md:grid-cols-3',
    4: 'md:grid-cols-4',
    5: 'md:grid-cols-5',
    6: 'md:grid-cols-6',
  }[autoTabletColumns] || 'md:grid-cols-3';

  // Get heading size class
  const getHeadingClass = () => {
    switch (headingSize) {
      case 'h2': return 'text-2xl md:text-3xl';
      case 'h1': return 'text-3xl md:text-4xl';
      case 'h0': return 'text-4xl md:text-5xl';
      case 'hxl': return 'text-5xl md:text-6xl';
      case 'hxxl': return 'text-6xl md:text-7xl';
      default: return 'text-4xl';
    }
  };

  // Get image aspect ratio class
  const getImageRatioClass = () => {
    switch (imageRatio) {
      case 'adapt': return '';
      case 'portrait': return 'aspect-[4/5]';
      case 'square': return 'aspect-square';
      default: return 'aspect-[4/5]';
    }
  };

  console.log('=== CollectionListBlock grid classes ===', {
    gridCols,
    mobileCols,
    tabletCols,
    autoMobileColumns,
    autoTabletColumns,
    finalClassName: `grid ${mobileCols} ${tabletCols} ${gridCols}`
  });

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="w-full">
        {/* Heading */}
        {heading && (
          <h2 className={`${getHeadingClass()} font-bold text-gray-900 mb-12 text-center`}>
            {heading}
          </h2>
        )}

        {/* Collection Grid - Exact same style as Product Grid */}
        <div
          className={`grid ${mobileCols} ${tabletCols} ${gridCols}`}
          style={{
            gap: '16px',
            rowGap: '24px' // More vertical spacing matching Product Grid
          }}
        >
          {displayCollections.map((collection: any) => (
            <CollectionCard
              key={collection.id}
              collection={collection}
              imageRatioClass={getImageRatioClass()}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
