"use client";

import React from 'react';
import { Button } from '@weldsuite/ui/components/button';

export interface ProductPolicyButtonsBlockProps {
  showShippingPolicy?: boolean;
  showRefundPolicy?: boolean;
  shippingPolicyText?: string;
  refundPolicyText?: string;
  borderRadius?: number;
  mode?: 'live' | 'edit' | 'preview';
  store?: {
    selectedProduct?: any;
    [key: string]: any;
  };
}

export function ProductPolicyButtonsBlock({
  showShippingPolicy = true,
  showRefundPolicy = true,
  shippingPolicyText = 'Shipping Policy',
  refundPolicyText = 'Refund Policy',
  borderRadius = 8,
  mode = 'live',
  store,
}: ProductPolicyButtonsBlockProps) {
  if (!showShippingPolicy && !showRefundPolicy) {
    return null;
  }

  return (
    <div className="flex gap-2">
      {showShippingPolicy && (
        <Button variant="outline" className="flex-1 shadow-none" style={{ borderRadius: `${borderRadius}px` }}>
          {shippingPolicyText}
        </Button>
      )}
      {showRefundPolicy && (
        <Button variant="outline" className="flex-1 shadow-none" style={{ borderRadius: `${borderRadius}px` }}>
          {refundPolicyText}
        </Button>
      )}
    </div>
  );
}
