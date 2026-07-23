"use client";

import React from 'react';

interface Money {
  amount: number;
  currency: string;
  formatted?: string;
}

export interface ProductPriceBlockProps {
  price?: string;
  compareAtPrice?: string;
  currency?: string;
  textColor?: string;
  mode?: 'live' | 'edit' | 'preview';
  store?: {
    selectedProduct?: any;
    [key: string]: any;
  };
}

// Helper to extract price from various formats
const extractPrice = (priceValue: number | string | Money | undefined): number => {
  if (!priceValue) return 0;
  if (typeof priceValue === 'object' && 'amount' in priceValue) {
    return priceValue.amount;
  }
  if (typeof priceValue === 'number') {
    return priceValue;
  }
  const parsed = parseFloat(priceValue);
  return isNaN(parsed) ? 0 : parsed;
};

export function ProductPriceBlock({
  price = '110',
  compareAtPrice = '',
  currency = '€',
  textColor = '#000000',
  mode = 'live',
  store,
}: ProductPriceBlockProps) {
  // Use product data from store if available
  const productPrice = store?.selectedProduct?.price;
  const productComparePrice = store?.selectedProduct?.compareAtPrice;

  const displayPrice = productPrice ? extractPrice(productPrice) : parseFloat(price);
  const displayComparePrice = productComparePrice ? extractPrice(productComparePrice) : (compareAtPrice ? parseFloat(compareAtPrice) : 0);

  const hasCompareAtPrice = displayComparePrice && displayComparePrice > displayPrice;

  return (
    <div className="text-lg font-medium" style={{ color: textColor }}>
      {currency}{displayPrice.toFixed(0)}
      {hasCompareAtPrice && (
        <span className="text-sm line-through opacity-50 ml-2">
          {currency}{displayComparePrice.toFixed(0)}
        </span>
      )}
    </div>
  );
}
