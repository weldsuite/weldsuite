"use client";

import { ProductRow } from '@weldsuite/ui/components/product-row';

interface ProductRowSectionProps {
  title?: string;
  brand?: string;
  products?: Array<{
    id: string;
    name: string;
    image: string;
    price: number;
  }>;
}

export function ProductRowSection({ 
  title = "More from",
  brand = "rhode",
  products = []
}: ProductRowSectionProps) {
  // If no products provided, use placeholder data
  const displayProducts = products.length > 0 ? products : [
    { id: '1', name: 'Product 1', image: '/api/placeholder/220/293', price: 0 },
    { id: '2', name: 'Product 2', image: '/api/placeholder/220/293', price: 0 },
    { id: '3', name: 'Product 3', image: '/api/placeholder/220/293', price: 0 },
    { id: '4', name: 'Product 4', image: '/api/placeholder/220/293', price: 0 },
    { id: '5', name: 'Product 5', image: '/api/placeholder/220/293', price: 0 },
    { id: '6', name: 'Product 6', image: '/api/placeholder/220/293', price: 0 },
    { id: '7', name: 'Product 7', image: '/api/placeholder/220/293', price: 0 },
    { id: '8', name: 'Product 8', image: '/api/placeholder/220/293', price: 0 },
  ];

  return (
    <div className="w-full">
      <ProductRow 
        title={title}
        brand={brand}
        products={displayProducts}
        onViewAll={() => console.log('View all clicked')}
      />
    </div>
  );
}