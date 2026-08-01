"use client";

import type { Product, StoreData } from '../types';
import { toPriceNumber } from '../lib/price';
import React from 'react';

export interface ProductPriceBlockProps {
  price?: string;
  compareAtPrice?: string;
  currency?: string;
  textColor?: string;
  mode?: 'live' | 'edit' | 'preview';
  store?: StoreData & { selectedProduct?: Product };
}

export function ProductPriceBlock({
  price = '110',
  compareAtPrice = '',
  currency = '€',
  textColor = '#000000',
  store,
}: ProductPriceBlockProps) {
  // Use product data from store if available
  const productPrice = store?.selectedProduct?.price;
  const productComparePrice = store?.selectedProduct?.compareAtPrice;

  const displayPrice = productPrice ? toPriceNumber(productPrice) : parseFloat(price);
  const displayComparePrice = productComparePrice ? toPriceNumber(productComparePrice) : (compareAtPrice ? parseFloat(compareAtPrice) : 0);

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
