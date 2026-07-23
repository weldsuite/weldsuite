"use client";

import React from 'react';

export interface ProductPolicyButtonsElementProps {
  shippingPolicyText?: string;
  refundPolicyText?: string;
  showShippingPolicy?: boolean;
  showRefundPolicy?: boolean;
  mode?: 'live' | 'edit' | 'preview';
}

export function ProductPolicyButtonsElement({
  shippingPolicyText = 'Verzendbeleid',
  refundPolicyText = 'Terugbetalingsbeleid',
  showShippingPolicy = true,
  showRefundPolicy = true,
  mode = 'live',
}: ProductPolicyButtonsElementProps) {
  if (!showShippingPolicy && !showRefundPolicy) {
    return null;
  }

  return (
    <div style={{ display: 'flex', gap: '0.5rem', paddingTop: '1rem' }}>
      {showShippingPolicy && (
        <button style={{
          flex: '1 1 0%',
          borderRadius: '0.5rem',
          padding: '0.5rem 1rem',
          border: '1px solid #e5e7eb',
          backgroundColor: 'white',
          cursor: 'pointer'
        }}>
          {shippingPolicyText}
        </button>
      )}
      {showRefundPolicy && (
        <button style={{
          flex: '1 1 0%',
          borderRadius: '0.5rem',
          padding: '0.5rem 1rem',
          border: '1px solid #e5e7eb',
          backgroundColor: 'white',
          cursor: 'pointer'
        }}>
          {refundPolicyText}
        </button>
      )}
    </div>
  );
}
