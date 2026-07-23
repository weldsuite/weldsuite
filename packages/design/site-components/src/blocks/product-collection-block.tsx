"use client";

import React, { useState, useMemo } from 'react';
import { ChevronDown, ChevronUp, X, SlidersHorizontal, Grid3X3, Grid2X2 } from 'lucide-react';

interface Product {
  id: string;
  name: string;
  link?: string;
  image?: string;
  images?: { url: string }[];
  price: number;
  compareAtPrice?: number;
  salePrice?: number;
  currency?: string;
  colors?: string[];
  sizes?: string[];
  category?: string;
}

export interface ProductCollectionBlockProps {
  title?: string;
  showFilters?: boolean;
  showSort?: boolean;
  columns?: 2 | 3 | 4;
  backgroundColor?: string;
  textColor?: string;
  filterBackgroundColor?: string;
  sidebarWidth?: number;
  imageRounding?: number;
  mode?: 'live' | 'preview' | 'edit';
  store?: {
    products?: Product[];
  };
}

// Default products for preview
const DEFAULT_PRODUCTS: Product[] = [
  {
    id: 'default-1',
    name: 'Classic Running Shoe',
    image: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/dynamic-sketches-sports-illustrated-sweatshirt.png',
    price: 129.99,
    currency: 'USD',
    colors: ['Black', 'White', 'Red'],
    sizes: ['S', 'M', 'L', 'XL'],
    category: 'Shoes',
  },
  {
    id: 'default-2',
    name: 'Premium Hoodie',
    image: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/black-hoodie-against-light-background.png',
    price: 89.99,
    currency: 'USD',
    colors: ['Black', 'Gray', 'Navy'],
    sizes: ['S', 'M', 'L', 'XL', 'XXL'],
    category: 'Hoodies',
  },
  {
    id: 'default-3',
    name: 'Crewneck Sweatshirt',
    image: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/bicolor-crewneck-sweatshirt-with-embroidered-logo.png',
    price: 75.00,
    currency: 'USD',
    colors: ['White', 'Beige', 'Blue'],
    sizes: ['S', 'M', 'L'],
    category: 'Sweatshirts',
  },
  {
    id: 'default-4',
    name: 'Elegant Stilettos',
    image: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/elegant-patent-stilettos-with-signature-red-soles.png',
    price: 245.00,
    currency: 'USD',
    colors: ['Black', 'Red'],
    sizes: ['36', '37', '38', '39', '40'],
    category: 'Shoes',
  },
  {
    id: 'default-5',
    name: 'Silk Scarf',
    image: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/elegant-peach-scarf.png',
    price: 65.00,
    currency: 'USD',
    colors: ['Peach', 'Pink', 'Cream'],
    sizes: ['One Size'],
    category: 'Accessories',
  },
  {
    id: 'default-6',
    name: 'Leather Handbag',
    image: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/maroon-leather-handbag.png',
    price: 350.00,
    currency: 'USD',
    colors: ['Maroon', 'Black', 'Brown'],
    sizes: ['One Size'],
    category: 'Bags',
  },
  {
    id: 'default-7',
    name: 'Basic Tank Top',
    image: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/minimalist-tank-top-flatlay.png',
    price: 29.99,
    currency: 'USD',
    colors: ['White', 'Black', 'Gray'],
    sizes: ['XS', 'S', 'M', 'L'],
    category: 'Tops',
  },
  {
    id: 'default-8',
    name: 'Designer Tote',
    image: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/modern-handbag-display.png',
    price: 425.00,
    currency: 'USD',
    colors: ['Tan', 'Black'],
    sizes: ['One Size'],
    category: 'Bags',
  },
  {
    id: 'default-9',
    name: 'Sport Jacket',
    image: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/dynamic-sketches-sports-illustrated-sweatshirt.png',
    price: 159.99,
    currency: 'USD',
    colors: ['Navy', 'Black', 'Green'],
    sizes: ['S', 'M', 'L', 'XL'],
    category: 'Jackets',
  },
];

const formatPrice = (price: number, currency: string) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency,
  }).format(price);
};

// Filter Section Component
function FilterSection({
  title,
  children,
  defaultOpen = true
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-gray-200 py-4">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between w-full text-left"
      >
        <span className="text-sm font-medium text-gray-900">{title}</span>
        {isOpen ? (
          <ChevronUp className="w-4 h-4 text-gray-500" />
        ) : (
          <ChevronDown className="w-4 h-4 text-gray-500" />
        )}
      </button>
      {isOpen && <div className="mt-3">{children}</div>}
    </div>
  );
}

export function ProductCollectionBlock({
  title = 'All Products',
  showFilters = true,
  showSort = true,
  columns = 3,
  backgroundColor = '#ffffff',
  textColor = '#171717',
  filterBackgroundColor = '#ffffff',
  sidebarWidth = 260,
  imageRounding = 0,
  mode = 'live',
  store,
}: ProductCollectionBlockProps) {
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [selectedColors, setSelectedColors] = useState<string[]>([]);
  const [selectedSizes, setSelectedSizes] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState<string>('featured');
  const [gridColumns, setGridColumns] = useState(columns);

  const products = store?.products?.length ? store.products : DEFAULT_PRODUCTS;

  // Extract unique filter values
  const allColors = useMemo(() => {
    const colors = new Set<string>();
    products.forEach(p => p.colors?.forEach(c => colors.add(c)));
    return Array.from(colors);
  }, [products]);

  const allSizes = useMemo(() => {
    const sizes = new Set<string>();
    products.forEach(p => p.sizes?.forEach(s => sizes.add(s)));
    return Array.from(sizes);
  }, [products]);

  const allCategories = useMemo(() => {
    const categories = new Set<string>();
    products.forEach(p => p.category && categories.add(p.category));
    return Array.from(categories);
  }, [products]);

  // Filter products
  const filteredProducts = useMemo(() => {
    let result = [...products];

    if (selectedColors.length > 0) {
      result = result.filter(p =>
        p.colors?.some(c => selectedColors.includes(c))
      );
    }

    if (selectedSizes.length > 0) {
      result = result.filter(p =>
        p.sizes?.some(s => selectedSizes.includes(s))
      );
    }

    if (selectedCategories.length > 0) {
      result = result.filter(p =>
        p.category && selectedCategories.includes(p.category)
      );
    }

    // Sort products
    switch (sortBy) {
      case 'price-low':
        result.sort((a, b) => a.price - b.price);
        break;
      case 'price-high':
        result.sort((a, b) => b.price - a.price);
        break;
      case 'newest':
        // In real app, sort by date
        break;
      default:
        // featured - keep original order
        break;
    }

    return result;
  }, [products, selectedColors, selectedSizes, selectedCategories, sortBy]);

  const toggleFilter = (
    value: string,
    selected: string[],
    setSelected: React.Dispatch<React.SetStateAction<string[]>>
  ) => {
    if (selected.includes(value)) {
      setSelected(selected.filter(v => v !== value));
    } else {
      setSelected([...selected, value]);
    }
  };

  const clearAllFilters = () => {
    setSelectedColors([]);
    setSelectedSizes([]);
    setSelectedCategories([]);
  };

  const hasActiveFilters = selectedColors.length > 0 || selectedSizes.length > 0 || selectedCategories.length > 0;

  const getProductImage = (product: Product): string => {
    if (product.image) return product.image;
    if (product.images && product.images.length > 0) return product.images[0].url;
    return '';
  };

  const getProductLink = (product: Product): string => {
    return product.link || `/products/${product.id}`;
  };

  const gridColsClass = {
    2: 'grid-cols-2',
    3: 'grid-cols-2 lg:grid-cols-3',
    4: 'grid-cols-2 lg:grid-cols-4',
  };

  // Filter Sidebar Content
  const FilterContent = () => (
    <div className="space-y-0">
      {/* Categories */}
      {allCategories.length > 0 && (
        <FilterSection title="Category">
          <div className="space-y-2">
            {allCategories.map(category => (
              <label key={category} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedCategories.includes(category)}
                  onChange={() => toggleFilter(category, selectedCategories, setSelectedCategories)}
                  className="w-4 h-4 rounded border-gray-300 text-gray-900 focus:ring-gray-900"
                />
                <span className="text-sm text-gray-600">{category}</span>
              </label>
            ))}
          </div>
        </FilterSection>
      )}

      {/* Colors */}
      {allColors.length > 0 && (
        <FilterSection title="Color">
          <div className="flex flex-wrap gap-2">
            {allColors.map(color => (
              <button
                key={color}
                onClick={() => toggleFilter(color, selectedColors, setSelectedColors)}
                className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${
                  selectedColors.includes(color)
                    ? 'border-gray-900 bg-gray-900 text-white'
                    : 'border-gray-300 hover:border-gray-400'
                }`}
              >
                {color}
              </button>
            ))}
          </div>
        </FilterSection>
      )}

      {/* Sizes */}
      {allSizes.length > 0 && (
        <FilterSection title="Size">
          <div className="flex flex-wrap gap-2">
            {allSizes.map(size => (
              <button
                key={size}
                onClick={() => toggleFilter(size, selectedSizes, setSelectedSizes)}
                className={`min-w-[40px] px-3 py-1.5 text-xs rounded border transition-colors ${
                  selectedSizes.includes(size)
                    ? 'border-gray-900 bg-gray-900 text-white'
                    : 'border-gray-300 hover:border-gray-400'
                }`}
              >
                {size}
              </button>
            ))}
          </div>
        </FilterSection>
      )}
    </div>
  );

  return (
    <section
      className="min-h-screen"
      style={{ backgroundColor }}
    >
      {/* Header */}
      <div className="border-b border-gray-200">
        <div className="max-w-[1920px] mx-auto px-5 lg:px-12 py-8">
          <h1
            className="text-3xl font-bold"
            style={{ color: textColor }}
          >
            {title}
          </h1>
          <p className="text-sm text-gray-500 mt-2">
            {filteredProducts.length} {filteredProducts.length === 1 ? 'product' : 'products'}
          </p>
        </div>
      </div>

      <div className="max-w-[1920px] mx-auto">
        <div className="flex">
          {/* Desktop Filter Sidebar */}
          {showFilters && (
            <aside
              className="hidden lg:block flex-shrink-0 border-r border-gray-200 sticky top-0 h-screen overflow-y-auto"
              style={{ width: sidebarWidth, backgroundColor: filterBackgroundColor }}
            >
              <div className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-sm font-semibold text-gray-900">Filters</h2>
                  {hasActiveFilters && (
                    <button
                      onClick={clearAllFilters}
                      className="text-xs text-gray-500 hover:text-gray-900 underline"
                    >
                      Clear all
                    </button>
                  )}
                </div>
                <FilterContent />
              </div>
            </aside>
          )}

          {/* Main Content */}
          <main className="flex-1 min-w-0">
            {/* Mobile Filter Bar & Sort */}
            <div className="sticky top-0 z-10 bg-white border-b border-gray-200 px-5 py-3 flex items-center justify-between gap-4">
              {/* Mobile Filter Button */}
              {showFilters && (
                <button
                  onClick={() => setMobileFiltersOpen(true)}
                  className="lg:hidden flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50"
                >
                  <SlidersHorizontal className="w-4 h-4" />
                  Filters
                  {hasActiveFilters && (
                    <span className="ml-1 px-1.5 py-0.5 bg-gray-900 text-white text-xs rounded-full">
                      {selectedColors.length + selectedSizes.length + selectedCategories.length}
                    </span>
                  )}
                </button>
              )}

              <div className="flex items-center gap-4 ml-auto">
                {/* Grid Toggle */}
                <div className="hidden sm:flex items-center gap-1 border border-gray-200 rounded-lg p-1">
                  <button
                    onClick={() => setGridColumns(2)}
                    className={`p-1.5 rounded ${gridColumns === 2 ? 'bg-gray-100' : 'hover:bg-gray-50'}`}
                  >
                    <Grid2X2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setGridColumns(3)}
                    className={`p-1.5 rounded ${gridColumns === 3 ? 'bg-gray-100' : 'hover:bg-gray-50'}`}
                  >
                    <Grid3X3 className="w-4 h-4" />
                  </button>
                </div>

                {/* Sort Dropdown */}
                {showSort && (
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value)}
                    className="px-4 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gray-900"
                  >
                    <option value="featured">Featured</option>
                    <option value="newest">Newest</option>
                    <option value="price-low">Price: Low to High</option>
                    <option value="price-high">Price: High to Low</option>
                  </select>
                )}
              </div>
            </div>

            {/* Active Filters Pills */}
            {hasActiveFilters && (
              <div className="px-5 py-3 flex flex-wrap gap-2 border-b border-gray-100">
                {selectedCategories.map(cat => (
                  <button
                    key={cat}
                    onClick={() => toggleFilter(cat, selectedCategories, setSelectedCategories)}
                    className="flex items-center gap-1 px-3 py-1 bg-gray-100 rounded-full text-xs"
                  >
                    {cat}
                    <X className="w-3 h-3" />
                  </button>
                ))}
                {selectedColors.map(color => (
                  <button
                    key={color}
                    onClick={() => toggleFilter(color, selectedColors, setSelectedColors)}
                    className="flex items-center gap-1 px-3 py-1 bg-gray-100 rounded-full text-xs"
                  >
                    {color}
                    <X className="w-3 h-3" />
                  </button>
                ))}
                {selectedSizes.map(size => (
                  <button
                    key={size}
                    onClick={() => toggleFilter(size, selectedSizes, setSelectedSizes)}
                    className="flex items-center gap-1 px-3 py-1 bg-gray-100 rounded-full text-xs"
                  >
                    Size: {size}
                    <X className="w-3 h-3" />
                  </button>
                ))}
              </div>
            )}

            {/* Product Grid */}
            <div className="p-5 lg:p-8">
              <div className={`grid gap-x-4 gap-y-8 ${gridColsClass[gridColumns as 2 | 3 | 4]}`}>
                {filteredProducts.map((product) => (
                  <a
                    key={product.id}
                    href={getProductLink(product)}
                    className="group block"
                    onClick={(e) => mode !== 'live' && e.preventDefault()}
                  >
                    <div
                      className="relative overflow-hidden bg-gray-100 aspect-[3/4] mb-3"
                      style={{ borderRadius: imageRounding }}
                    >
                      <img
                        src={getProductImage(product)}
                        alt={product.name}
                        className="w-full h-full object-cover object-center transition-transform duration-300 group-hover:scale-105"
                      />
                    </div>
                    <div className="px-1">
                      <h3
                        className="text-sm font-medium mb-1 line-clamp-2"
                        style={{ color: textColor }}
                      >
                        {product.name}
                      </h3>
                      {product.category && (
                        <p className="text-xs text-gray-500 mb-1">{product.category}</p>
                      )}
                      <p
                        className="text-sm font-semibold"
                        style={{ color: textColor }}
                      >
                        {formatPrice(product.price, product.currency || 'USD')}
                      </p>
                      {product.colors && product.colors.length > 1 && (
                        <p className="text-xs text-gray-500 mt-1">
                          {product.colors.length} colors
                        </p>
                      )}
                    </div>
                  </a>
                ))}
              </div>

              {filteredProducts.length === 0 && (
                <div className="text-center py-16">
                  <p className="text-gray-500">No products match your filters.</p>
                  <button
                    onClick={clearAllFilters}
                    className="mt-4 text-sm text-gray-900 underline hover:no-underline"
                  >
                    Clear all filters
                  </button>
                </div>
              )}
            </div>
          </main>
        </div>
      </div>

      {/* Mobile Filter Drawer */}
      {mobileFiltersOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setMobileFiltersOpen(false)}
          />
          <div
            className="absolute inset-y-0 left-0 w-full max-w-sm bg-white shadow-xl overflow-y-auto"
            style={{ backgroundColor: filterBackgroundColor }}
          >
            <div className="sticky top-0 bg-white border-b border-gray-200 px-4 py-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Filters</h2>
              <button
                onClick={() => setMobileFiltersOpen(false)}
                className="p-2 -mr-2 hover:bg-gray-100 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4">
              <FilterContent />
            </div>
            <div className="sticky bottom-0 bg-white border-t border-gray-200 p-4 flex gap-3">
              <button
                onClick={clearAllFilters}
                className="flex-1 px-4 py-3 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50"
              >
                Clear all
              </button>
              <button
                onClick={() => setMobileFiltersOpen(false)}
                className="flex-1 px-4 py-3 bg-gray-900 text-white rounded-lg text-sm font-medium hover:bg-gray-800"
              >
                View Results ({filteredProducts.length})
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
