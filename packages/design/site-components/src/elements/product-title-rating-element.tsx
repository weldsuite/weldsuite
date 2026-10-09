"use client";

import React from 'react';
import { Star } from 'lucide-react';
import { starSlots } from '../lib/list-keys';

export interface ProductTitleRatingElementProps {
  productName?: string;
  showRating?: boolean;
  rating?: number;
  reviewCount?: number;
}

export function ProductTitleRatingElement({
  productName = 'glazing milk',
  showRating = true,
  rating = 4.8,
  reviewCount = 14600,
}: Readonly<ProductTitleRatingElementProps>) {
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
            {starSlots(5).map((star) => (
              <Star
                key={star}
                style={{
                  height: '1rem',
                  width: '1rem',
                  fill: star <= Math.floor(rating) ? 'currentColor' : '#e5e7eb',
                  color: star <= Math.floor(rating) ? 'currentColor' : '#e5e7eb'
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
