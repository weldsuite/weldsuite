"use client";

import React, { useState } from 'react';
import { Minus, Plus } from 'lucide-react';

export interface ProductQuantitySelectorBlockProps {
  textColor?: string;
  minQuantity?: number;
  maxQuantity?: number;
  borderRadius?: number;
  mode?: 'live' | 'edit' | 'preview';
  store?: {
    selectedProduct?: any;
    [key: string]: any;
  };
}

export function ProductQuantitySelectorBlock({
  textColor = '#000000',
  minQuantity = 1,
  maxQuantity = 99,
  borderRadius = 8,
  mode = 'live',
  store,
}: ProductQuantitySelectorBlockProps) {
  // Use product stock as max quantity if available
  const productStock = store?.selectedProduct?.stock;
  const displayMaxQuantity = productStock ? Math.min(productStock, maxQuantity) : maxQuantity;

  const [quantity, setQuantity] = useState(1);

  return (
    <div className="flex items-center justify-between">
      <span className="text-sm font-semibold" style={{ color: textColor }}>
        Total
      </span>
      <div className="flex items-center bg-gray-100 overflow-hidden" style={{ borderRadius: `${borderRadius}px` }}>
        <button
          onClick={() => setQuantity(Math.max(minQuantity, quantity - 1))}
          className="p-2 hover:bg-gray-200 transition-colors"
          disabled={quantity <= minQuantity}
        >
          <Minus className="h-4 w-4" />
        </button>
        <span className="px-4 text-base font-medium">{quantity}</span>
        <button
          onClick={() => setQuantity(Math.min(displayMaxQuantity, quantity + 1))}
          className="p-2 hover:bg-gray-200 transition-colors"
          disabled={quantity >= displayMaxQuantity}
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
