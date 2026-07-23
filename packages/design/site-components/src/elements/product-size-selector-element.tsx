"use client";

import React from 'react';

export interface ProductSizeSelectorElementProps {
  sizes?: string[];
  selectedSize: string;
  onSizeChange: (size: string) => void;
  buttonColor?: string;
  label?: string;
  mode?: 'live' | 'edit' | 'preview';
}

export function ProductSizeSelectorElement({
  sizes = ['big (4.2 oz)', 'little (2.2 oz)'],
  selectedSize,
  onSizeChange,
  buttonColor = '#000000',
  label = 'Size',
  mode = 'live',
}: ProductSizeSelectorElementProps) {
  return (
    <div>
      <p style={{ fontSize: '0.875rem', fontWeight: '600', marginBottom: '0.5rem' }}>
        {label} <span style={{ fontWeight: 'normal' }}>{selectedSize}</span>
      </p>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        {sizes.map((size) => (
          <button
            key={size}
            onClick={() => onSizeChange(size)}
            style={{
              borderRadius: '9999px',
              padding: '0.5rem 1rem',
              fontSize: '0.875rem',
              border: selectedSize === size ? 'none' : '1px solid #e5e7eb',
              backgroundColor: selectedSize === size ? buttonColor : 'white',
              color: selectedSize === size ? 'white' : 'inherit',
              cursor: 'pointer'
            }}
          >
            {size}
          </button>
        ))}
      </div>
    </div>
  );
}
