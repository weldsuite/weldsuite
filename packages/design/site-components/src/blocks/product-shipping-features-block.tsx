"use client";

import React from 'react';
import { Truck, Store, RotateCcw } from 'lucide-react';

export interface ProductShippingFeaturesBlockProps {
  showHomeDelivery?: boolean;
  homeDeliveryText?: string;
  homeDeliveryMinAmount?: string;
  showStorePickup?: boolean;
  storePickupText?: string;
  storePickupMinAmount?: string;
  showReturns?: boolean;
  returnsText?: string;
  returnsDays?: string;
  textColor?: string;
  iconColor?: string;
  mode?: 'live' | 'edit' | 'preview';
}

export function ProductShippingFeaturesBlock({
  showHomeDelivery = true,
  homeDeliveryText = 'gratis thuisbezorgd vanaf',
  homeDeliveryMinAmount = '30-',
  showStorePickup = true,
  storePickupText = 'gratis afhalen in 500+ winkels vanaf',
  storePickupMinAmount = '15-',
  showReturns = true,
  returnsText = 'gratis retourneren binnen',
  returnsDays = '30 dagen',
  textColor = '#000000',
  iconColor = '#000000',
  mode = 'live',
}: ProductShippingFeaturesBlockProps) {
  return (
    <div className="w-full space-y-3">
      {showHomeDelivery && (
        <div className="flex items-start gap-3">
          <Truck
            className="w-5 h-5 flex-shrink-0 mt-0.5"
            style={{ color: iconColor }}
          />
          <span
            className="text-sm"
            style={{ color: textColor }}
          >
            {homeDeliveryText} {homeDeliveryMinAmount}
          </span>
        </div>
      )}
      {showStorePickup && (
        <div className="flex items-start gap-3">
          <Store
            className="w-5 h-5 flex-shrink-0 mt-0.5"
            style={{ color: iconColor }}
          />
          <span
            className="text-sm"
            style={{ color: textColor }}
          >
            {storePickupText} {storePickupMinAmount}
          </span>
        </div>
      )}
      {showReturns && (
        <div className="flex items-start gap-3">
          <RotateCcw
            className="w-5 h-5 flex-shrink-0 mt-0.5"
            style={{ color: iconColor }}
          />
          <span
            className="text-sm"
            style={{ color: textColor }}
          >
            {returnsText} {returnsDays}
          </span>
        </div>
      )}
    </div>
  );
}
