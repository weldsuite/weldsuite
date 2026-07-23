"use client";

import React, { useState } from 'react';
import { cn } from '@weldsuite/ui/lib/utils';

export interface ProductSizeSelectorBlockProps {
  availableSizes?: string[];
  textColor?: string;
  showSizeFit?: boolean;
  borderRadius?: number;
  mode?: 'live' | 'edit' | 'preview';
  store?: {
    selectedProduct?: any;
    [key: string]: any;
  };
}

export function ProductSizeSelectorBlock({
  availableSizes = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'],
  textColor = '#000000',
  showSizeFit = true,
  borderRadius = 6,
  mode = 'live',
  store,
}: ProductSizeSelectorBlockProps) {
  // Extract sizes from product variants if available
  const productSizes = store?.selectedProduct?.variants
    ?.filter((v: any) => v.size)
    .map((v: any) => v.size) || [];

  // Remove duplicates
  const uniqueSizes = [...new Set(productSizes)];
  const displaySizes = uniqueSizes.length > 0 ? uniqueSizes : availableSizes;

  const [selectedSize, setSelectedSize] = useState(String(displaySizes[0] || 'M'));

  return (
    <div>
      <div className="flex items-end justify-between mb-2">
        <p className="text-sm font-semibold" style={{ color: textColor }}>
          Size: <span className="font-normal">{selectedSize}</span>
        </p>
        {showSizeFit && (
          <button className="text-sm underline" style={{ color: textColor }}>
            Size & Fit
          </button>
        )}
      </div>
      <div className="inline-flex border overflow-hidden" style={{ width: '100%', borderRadius: `${borderRadius}px` }}>
        {displaySizes.map((size: any, index: number) => (
          <button
            key={String(size)}
            onClick={() => setSelectedSize(String(size))}
            className={cn(
              "flex-1 h-10 text-sm transition-colors",
              index < displaySizes.length - 1 && "border-r",
              selectedSize === String(size)
                ? "bg-primary text-primary-foreground"
                : "bg-background hover:bg-muted"
            )}
          >
            {String(size)}
          </button>
        ))}
      </div>
    </div>
  );
}
