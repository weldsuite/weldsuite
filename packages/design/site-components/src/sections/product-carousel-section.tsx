"use client";

import { ProductCarousel } from '@weldsuite/ui/components/product-carousel';

interface ProductCarouselSectionProps {
  title?: string;
  products?: Array<{
    id: string;
    name: string;
    brand: string;
    image: string;
    price?: number;
  }>;
}

export function ProductCarouselSection({ 
  title = "More from our collection",
  products = []
}: ProductCarouselSectionProps) {
  // If no products provided, use placeholder data
  const displayProducts = products.length > 0 ? products : [
    { id: '1', name: 'Sample Product 1', brand: 'Brand', image: '/api/placeholder/200/200', price: 29.99 },
    { id: '2', name: 'Sample Product 2', brand: 'Brand', image: '/api/placeholder/200/200', price: 39.99 },
    { id: '3', name: 'Sample Product 3', brand: 'Brand', image: '/api/placeholder/200/200', price: 49.99 },
    { id: '4', name: 'Sample Product 4', brand: 'Brand', image: '/api/placeholder/200/200', price: 59.99 },
    { id: '5', name: 'Sample Product 5', brand: 'Brand', image: '/api/placeholder/200/200', price: 69.99 },
    { id: '6', name: 'Sample Product 6', brand: 'Brand', image: '/api/placeholder/200/200', price: 79.99 },
  ];

  return (
    <div className="py-12 px-4">
      <div className="max-w-7xl mx-auto">
        <ProductCarousel 
          title={title}
          products={displayProducts}
        />
      </div>
    </div>
  );
}