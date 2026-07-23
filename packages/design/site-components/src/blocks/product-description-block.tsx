"use client";

import React from 'react';

export interface ProductDescriptionBlockProps {
  description?: string;
  heading?: string;
  textColor?: string;
  mode?: 'live' | 'edit' | 'preview';
  store?: {
    selectedProduct?: any;
    [key: string]: any;
  };
}

export function ProductDescriptionBlock({
  description = 'The essential prep step for your skincare routine. Glazing Milk is a potent, nutrient-rich complex with a milky texture that leaves skin feeling hydrated and glowy while boosting the skin barrier over time.',
  heading = 'Omschrijving',
  textColor = '#000000',
  mode = 'live',
  store,
}: ProductDescriptionBlockProps) {
  // Use product data from store if available
  const displayDescription = store?.selectedProduct?.description || description;

  return (
    <div>
      <h3 className="font-semibold text-base mb-2" style={{ color: textColor }}>
        {heading}
      </h3>
      <p className="text-sm leading-relaxed" style={{ color: textColor, opacity: 0.8 }}>
        {displayDescription}
      </p>
    </div>
  );
}
