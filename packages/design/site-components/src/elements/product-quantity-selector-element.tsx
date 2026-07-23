"use client";

import React from 'react';

export interface ProductQuantitySelectorElementProps {
  quantity: number;
  onQuantityChange: (quantity: number) => void;
  minQuantity?: number;
  maxQuantity?: number;
  label?: string;
  mode?: 'live' | 'edit' | 'preview';
}

export function ProductQuantitySelectorElement({
  quantity,
  onQuantityChange,
  minQuantity = 1,
  maxQuantity = 99,
  label = 'Aantal',
  mode = 'live',
}: ProductQuantitySelectorElementProps) {
  return (
    <div>
      <p style={{ fontSize: '0.875rem', fontWeight: '600', marginBottom: '0.5rem' }}>
        {label}
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <button
          onClick={() => onQuantityChange(Math.max(minQuantity, quantity - 1))}
          disabled={quantity <= minQuantity}
          style={{
            height: '2.5rem',
            width: '2.5rem',
            borderRadius: '9999px',
            border: '1px solid #e5e7eb',
            backgroundColor: 'white',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: quantity <= minQuantity ? 'not-allowed' : 'pointer',
            opacity: quantity <= minQuantity ? 0.5 : 1
          }}
        >
          −
        </button>
        <span style={{ fontSize: '1.125rem', fontWeight: '600', width: '2rem', textAlign: 'center' }}>
          {quantity}
        </span>
        <button
          onClick={() => onQuantityChange(Math.min(maxQuantity, quantity + 1))}
          disabled={quantity >= maxQuantity}
          style={{
            height: '2.5rem',
            width: '2.5rem',
            borderRadius: '9999px',
            border: '1px solid #e5e7eb',
            backgroundColor: 'white',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: quantity >= maxQuantity ? 'not-allowed' : 'pointer',
            opacity: quantity >= maxQuantity ? 0.5 : 1
          }}
        >
          +
        </button>
      </div>
    </div>
  );
}
