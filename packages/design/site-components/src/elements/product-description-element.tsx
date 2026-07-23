"use client";

import React from 'react';

export interface ProductDescriptionElementProps {
  description?: string;
  heading?: string;
  storeName?: string;
  showStoreLink?: boolean;
  mode?: 'live' | 'edit' | 'preview';
}

export function ProductDescriptionElement({
  description = 'The essential prep step for your skincare routine. Glazing Milk is a potent, nutrient-rich complex with a milky texture that leaves skin feeling hydrated and glowy while boosting the skin barrier over time.',
  heading = 'Omschrijving',
  storeName = 'rhode',
  showStoreLink = true,
  mode = 'live',
}: ProductDescriptionElementProps) {
  return (
    <>
      {/* Description */}
      <div style={{ paddingTop: '1.5rem', borderTop: '1px solid #e5e7eb' }}>
        <h3 style={{ fontWeight: '600', fontSize: '1rem', marginBottom: '0.5rem' }}>
          {heading}
        </h3>
        <p style={{
          fontSize: '0.875rem',
          lineHeight: '1.5',
          opacity: 0.8
        }}>
          {description}
        </p>
      </div>

      {/* Store Link */}
      {showStoreLink && (
        <div style={{ paddingTop: '1rem' }}>
          <button
            style={{
              fontSize: '0.875rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.25rem',
              textDecoration: 'underline',
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              padding: 0
            }}
          >
            ↗ Meer gegevens op {storeName}
          </button>
        </div>
      )}
    </>
  );
}
