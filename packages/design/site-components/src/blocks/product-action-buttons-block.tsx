"use client";

import React from 'react';
import { Button } from '@weldsuite/ui/components/button';

export interface ProductActionButtonsBlockProps {
  addToCartText?: string;
  orderNowText?: string;
  addToCartColor?: string;
  orderNowColor?: string;
  showAddToCart?: boolean;
  showOrderNow?: boolean;
  borderRadius?: number;
  mode?: 'live' | 'edit' | 'preview';
  store?: {
    selectedProduct?: any;
    [key: string]: any;
  };
}

export function ProductActionButtonsBlock({
  addToCartText = 'Add to cart',
  orderNowText = 'Order now',
  addToCartColor = '#0070FF',
  orderNowColor = '#000000',
  showAddToCart = true,
  showOrderNow = true,
  borderRadius = 8,
  mode = 'live',
  store,
}: ProductActionButtonsBlockProps) {
  const getDarkerColor = (color: string) => {
    // Simple color darkening - could be improved
    if (color === '#0070FF') return '#0059CC';
    if (color === '#000000') return '#1a1a1a';
    return color;
  };

  return (
    <div className="w-full space-y-3">
      {showAddToCart && (
        <Button
          className="w-full h-12 text-base text-white"
          style={{ backgroundColor: addToCartColor, opacity: 1, borderRadius: `${borderRadius}px` }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = getDarkerColor(addToCartColor)}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = addToCartColor}
        >
          {addToCartText}
        </Button>
      )}
      {showOrderNow && (
        <Button
          className="w-full h-12 text-base text-white"
          style={{ backgroundColor: orderNowColor, opacity: 1, borderRadius: `${borderRadius}px` }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = getDarkerColor(orderNowColor)}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = orderNowColor}
        >
          {orderNowText}
        </Button>
      )}
    </div>
  );
}
