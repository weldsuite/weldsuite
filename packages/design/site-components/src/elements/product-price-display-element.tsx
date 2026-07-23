"use client";

import React from 'react';

export interface ProductPriceDisplayElementProps {
  price?: number;
  compareAtPrice?: number;
  showShipping?: boolean;
  shippingText?: string;
  mode?: 'live' | 'edit' | 'preview';
}

export function ProductPriceDisplayElement({
  price = 32.00,
  compareAtPrice,
  showShipping = true,
  shippingText = '🚚 Verzendkosten worden berekend bij de checkout',
  mode = 'live',
}: ProductPriceDisplayElementProps) {
  return (
    <>
      {/* Price */}
      <div style={{ fontSize: '1.875rem', fontWeight: 'bold', lineHeight: '2.25rem' }}>
        US$ {typeof price === 'number' ? price.toFixed(2) : parseFloat(String(price)).toFixed(2)}
        {compareAtPrice && (
          <span style={{
            fontSize: '1.125rem',
            textDecoration: 'line-through',
            opacity: 0.5,
            marginLeft: '0.5rem'
          }}>
            US$ {parseFloat(String(compareAtPrice)).toFixed(2)}
          </span>
        )}
      </div>

      {/* Shipping Info */}
      {showShipping && (
        <p style={{ fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {shippingText}
        </p>
      )}
    </>
  );
}
