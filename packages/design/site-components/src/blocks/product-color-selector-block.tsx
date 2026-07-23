"use client";

import React, { useState } from 'react';
import { cn } from '@weldsuite/ui/lib/utils';

export interface ProductColorSelectorBlockProps {
  availableColors?: Array<{ name: string; color: string }>;
  textColor?: string;
  borderRadius?: number;
  mode?: 'live' | 'edit' | 'preview';
  store?: {
    selectedProduct?: any;
    [key: string]: any;
  };
}

export function ProductColorSelectorBlock({
  availableColors = [
    { name: 'Black', color: '#000000' },
    { name: 'White', color: '#FFFFFF' },
    { name: 'Gray', color: '#9CA3AF' },
    { name: 'Blue', color: '#3B82F6' },
    { name: 'Red', color: '#EF4444' },
    { name: 'Green', color: '#10B981' },
  ],
  textColor = '#000000',
  borderRadius = 9999,
  mode = 'live',
  store,
}: ProductColorSelectorBlockProps) {
  // Extract colors from product variants if available
  const productColors = store?.selectedProduct?.variants
    ?.filter((v: any) => v.color)
    .map((v: any) => ({ name: v.color, color: v.colorHex || '#000000' })) || [];

  const displayColors = productColors.length > 0 ? productColors : availableColors;
  const [selectedColor, setSelectedColor] = useState(displayColors[0]?.name || 'Black');

  return (
    <div>
      <p className="text-sm font-semibold mb-2" style={{ color: textColor }}>
        Color: <span className="font-normal">{selectedColor}</span>
      </p>
      <div className="flex gap-2">
        {displayColors.map((colorOption: any) => (
          <button
            key={colorOption.name}
            onClick={() => setSelectedColor(colorOption.name)}
            className={cn(
              "w-7 h-7 transition-all",
              selectedColor === colorOption.name
                ? "ring-2 ring-inset ring-black"
                : colorOption.name === 'White' ? "border-2 border-gray-300 hover:border-gray-400" : ""
            )}
            style={{
              backgroundColor: colorOption.color,
              borderRadius: `${borderRadius}px`
            }}
            title={colorOption.name}
          />
        ))}
      </div>
    </div>
  );
}
