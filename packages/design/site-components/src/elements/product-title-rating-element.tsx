"use client";

import React from 'react';
import { Star } from 'lucide-react';

export interface ProductTitleRatingElementProps {
  productName?: string;
  showRating?: boolean;
  rating?: number;
  reviewCount?: number;
  mode?: 'live' | 'edit' | 'preview';
}

export function ProductTitleRatingElement({
  productName = 'glazing milk',
  showRating = true,
  rating = 4.8,
  reviewCount = 14600,
  mode = 'live',
}: ProductTitleRatingElementProps) {
  return (
    <div>
      <h1 style={{
        fontSize: '1.875rem',
        fontWeight: 'bold',
        marginBottom: '0.5rem',
        lineHeight: '2.25rem'
      }}>
        {productName}
      </h1>
      {/* Rating */}
      {showRating && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {[...Array(5)].map((_, i) => (
              <Star
                key={i}
                style={{
                  height: '1rem',
                  width: '1rem',
                  fill: i < Math.floor(rating) ? 'currentColor' : '#e5e7eb',
                  color: i < Math.floor(rating) ? 'currentColor' : '#e5e7eb'
                }}
              />
            ))}
          </div>
          <button style={{
            fontSize: '0.875rem',
            textDecoration: 'underline',
            border: 'none',
            background: 'none',
            cursor: 'pointer',
            padding: 0
          }}>
            {reviewCount.toLocaleString()} beoordelingen
          </button>
        </div>
      )}
    </div>
  );
}
