"use client";

import React from 'react';

export interface ProductTitleBlockProps {
  productName?: string;
  textColor?: string;
  mode?: 'live' | 'edit' | 'preview';
  store?: {
    selectedProduct?: any;
    [key: string]: any;
  };
}

export function ProductTitleBlock({
  productName = 'glazing milk',
  textColor = '#000000',
  mode = 'live',
  store,
}: ProductTitleBlockProps) {
  // Use product data from store if available
  const displayName = store?.selectedProduct?.name || productName;

  return (
    <div>
      <h1 className="text-3xl md:text-4xl font-bold" style={{ color: textColor }}>
        {displayName}
      </h1>
    </div>
  );
}
